/**
 * Battleship UI backend server.
 *
 * Run with:
 *   Terminal 1:  npx hardhat node
 *   Terminal 2:  npx hardhat task:ui-server --network localhost
 *   Browser:     http://localhost:3001
 *
 * Handles all FHE encryption and contract calls server-side so the browser
 * needs no special libraries — just fetch() and vanilla JS.
 */

import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { task } from "hardhat/config";

task("task:ui-server", "Start the Confidential Battleship game server").setAction(async (_, hre) => {
  const { ethers, fhevm } = hre;
  await fhevm.initializeCLIApi();

  const signers = await ethers.getSigners();
  const players = [signers[1], signers[2]]; // index 0 = Alice, index 1 = Bob

  // Deploy a fresh contract for this session
  const factory = await ethers.getContractFactory("ConfidentialBattleship");
  const contract = await factory.deploy();
  const contractAddress = await contract.getAddress();

  // Pre-warm the FHE key cache so the first commitBoard call is instant.
  // Without this, the very first fhevm.createEncryptedInput().encrypt() fetches
  // the network's FHE public key, which can take 30–120 s on a cold start.
  process.stdout.write("  Warming up FHE keys… ");
  await fhevm.createEncryptedInput(contractAddress, players[0].address).add32(0).encrypt();
  console.log("done.");

  // Shot history kept in memory — the contract stores results on-chain but
  // we track them here too so the UI can render hits/misses per cell.
  type Shot = { gameId: number; playerIdx: number; x: number; y: number; isHit: boolean };
  const allShots: Shot[] = [];

  // ── HTTP helpers ────────────────────────────────────────────────────────

  async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {}));
    });
  }

  function send(res: http.ServerResponse, status: number, data: unknown) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  }

  // ── Request router ──────────────────────────────────────────────────────

  const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", "http://localhost:3001");

    try {
      // ── Serve the UI HTML ─────────────────────────────────────────────
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        const html = fs.readFileSync(path.join(process.cwd(), "ui", "index.html"), "utf-8");
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(html);
        return;
      }

      // ── GET /api/info ─────────────────────────────────────────────────
      if (req.method === "GET" && url.pathname === "/api/info") {
        send(res, 200, {
          contractAddress,
          players: [players[0].address, players[1].address],
        });
        return;
      }

      // ── GET /api/game-state/:gameId ───────────────────────────────────
      if (req.method === "GET" && url.pathname.startsWith("/api/game-state/")) {
        const gameId = BigInt(url.pathname.split("/").pop()!);
        const [phase, turn, [p0, p1], hits0, hits1, winner, hasPending] = await Promise.all([
          contract.getPhase(gameId),
          contract.getTurn(gameId),
          contract.getPlayers(gameId),
          contract.getHits(gameId, 0),
          contract.getHits(gameId, 1),
          contract.getWinner(gameId),
          contract.hasPendingShot(gameId),
        ]);
        send(res, 200, {
          phase: Number(phase),
          turn: Number(turn),
          players: [p0, p1],
          hitsScored: [Number(hits0), Number(hits1)],
          winner,
          hasPending,
          shots: allShots.filter((s) => s.gameId === Number(gameId)),
        });
        return;
      }

      const body = await readBody(req);

      // ── POST /api/create-game ─────────────────────────────────────────
      // Hot-seat mode: Alice creates and Bob immediately joins so the game
      // enters Committing phase before either player places ships.
      if (req.method === "POST" && url.pathname === "/api/create-game") {
        const gameId = await contract.connect(players[0]).createGame.staticCall();
        await (await contract.connect(players[0]).createGame()).wait();
        await (await contract.connect(players[1]).joinGame(gameId)).wait();
        console.log(`[game] created #${gameId}, both players joined`);
        send(res, 200, { gameId: Number(gameId) });
        return;
      }

      // ── POST /api/commit-board  { gameId, playerIdx, cells: number[] } ─
      // cells = array of bit indices (0–24) where ships are placed
      if (req.method === "POST" && url.pathname === "/api/commit-board") {
        const { gameId, playerIdx, cells } = body as {
          gameId: number;
          playerIdx: number;
          cells: number[];
        };
        const who = playerIdx === 0 ? "Alice" : "Bob";
        const player = players[playerIdx];

        // Convert list of cell indices to a 25-bit bitmask
        const boardValue = cells.reduce((acc, bit) => acc | (1 << bit), 0);

        process.stdout.write(`[game] ${who} encrypting board… `);
        const enc = await fhevm.createEncryptedInput(contractAddress, player.address).add32(boardValue).encrypt();
        console.log("done.");

        process.stdout.write(`[game] ${who} submitting commitBoard tx… `);
        await (await contract.connect(player).commitBoard(BigInt(gameId), enc.handles[0], enc.inputProof)).wait();
        console.log("done.");

        process.stdout.write(`[game] ${who} verifying board (homomorphic popcount)… `);
        const countHandle = await contract.getPendingBoardCount(BigInt(gameId), playerIdx);
        const countDecryption = await fhevm.publicDecrypt([countHandle]);
        await (
          await contract.verifyBoard(
            BigInt(gameId),
            playerIdx,
            [countHandle],
            countDecryption.abiEncodedClearValues,
            countDecryption.decryptionProof,
          )
        ).wait();
        console.log("done.");

        console.log(`[game] ${who} committed and verified board for #${gameId}`);
        send(res, 200, { ok: true });
        return;
      }

      // ── POST /api/fire  { gameId, playerIdx, x, y } ──────────────────
      if (req.method === "POST" && url.pathname === "/api/fire") {
        const { gameId, playerIdx, x, y } = body as {
          gameId: number;
          playerIdx: number;
          x: number;
          y: number;
        };
        const player = players[playerIdx];

        // Transaction 1: FHE computation on encrypted board
        await (await contract.connect(player).fire(BigInt(gameId), x, y)).wait();

        // Ask mock KMS to decrypt the pending ebool
        const pendingHandle = await contract.getPendingResult(BigInt(gameId));
        const decryption = await fhevm.publicDecrypt([pendingHandle]);

        // Transaction 2: submit KMS proof on-chain to reveal hit/miss
        await (
          await contract.resolveShot(
            BigInt(gameId),
            [pendingHandle],
            decryption.abiEncodedClearValues,
            decryption.decryptionProof,
          )
        ).wait();

        const [rawResult] = ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], decryption.abiEncodedClearValues);
        const isHit = rawResult !== 0n;

        allShots.push({ gameId: Number(gameId), playerIdx, x, y, isHit });

        const shooter = playerIdx === 0 ? "Alice" : "Bob";
        console.log(`[game] ${shooter} fired at (${x},${y}) → ${isHit ? "HIT" : "miss"}`);

        send(res, 200, { isHit });
        return;
      }

      send(res, 404, { error: "Not found" });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[server error]", msg);
      send(res, 500, { error: msg });
    }
  });

  server.listen(3001, () => {
    console.log("\n╔══════════════════════════════════════════════╗");
    console.log("║   Confidential Battleship — UI Server        ║");
    console.log("╚══════════════════════════════════════════════╝");
    console.log(`\n  Contract : ${contractAddress}`);
    console.log(`  Alice    : ${players[0].address}`);
    console.log(`  Bob      : ${players[1].address}`);
    console.log("\n  Open http://localhost:3001 in your browser\n");
  });

  // Keep the task alive until Ctrl+C
  await new Promise<void>(() => {});
});

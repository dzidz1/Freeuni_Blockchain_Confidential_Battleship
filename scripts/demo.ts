/**
 * Confidential Battleship — Live Demo Script
 *
 * Run with (two terminals):
 *   Terminal 1:  npx hardhat node
 *   Terminal 2:  npx hardhat run scripts/demo.ts --network localhost
 *
 * Deploys a fresh game, commits two secret boards, plays to a win,
 * and prints the encrypted handles at every step so the audience can
 * see that the board is unreadable gibberish on-chain.
 */

import { ethers, fhevm } from "hardhat";
import { ConfidentialBattleship__factory } from "../types";

// ── Board layout ──────────────────────────────────────────────────────────────
// Cell (x, y) → bit (y*5 + x) in a 25-bit bitmask packed into euint32
function boardBitmask(cells: [number, number][]): number {
  return cells.reduce((acc, [x, y]) => acc | (1 << (y * 5 + x)), 0);
}

const ALICE_SHIPS: [number, number][] = [
  [0, 0],
  [2, 1],
  [4, 4],
];

const BOB_SHIPS: [number, number][] = [
  [1, 0],
  [1, 1],
  [3, 2],
];

// ── Display helpers ───────────────────────────────────────────────────────────
function short(hex: string): string {
  return hex.slice(0, 10) + "..." + hex.slice(-6);
}

function shipList(cells: [number, number][]): string {
  return cells.map(([x, y]) => `(${x},${y})`).join("  ");
}

function line(char = "─", width = 56): string {
  return char.repeat(width);
}

// ── Core helpers ──────────────────────────────────────────────────────────────
async function encryptBoard(contractAddress: string, playerAddress: string, boardValue: number) {
  const enc = await fhevm.createEncryptedInput(contractAddress, playerAddress).add32(boardValue).encrypt();
  return { handle: enc.handles[0], proof: enc.inputProof };
}

async function fireAndResolve(
  contract: Awaited<ReturnType<ConfidentialBattleship__factory["deploy"]>>,
  shooter: Awaited<ReturnType<typeof ethers.getSigner>>,
  gameId: bigint,
  x: number,
  y: number,
): Promise<{ isHit: boolean; resultHandle: string }> {
  await (await contract.connect(shooter).fire(gameId, x, y)).wait();

  const resultHandle = await contract.getPendingResult(gameId);
  const decryption = await fhevm.publicDecrypt([resultHandle]);

  await (
    await contract.resolveShot(gameId, [resultHandle], decryption.abiEncodedClearValues, decryption.decryptionProof)
  ).wait();

  const [rawResult] = ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], decryption.abiEncodedClearValues);

  return { isHit: rawResult !== 0n, resultHandle };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  await fhevm.initializeCLIApi();

  const signers = await ethers.getSigners();
  const alice = signers[1];
  const bob = signers[2];

  console.log();
  console.log("╔" + line("═") + "╗");
  console.log("║" + "   CONFIDENTIAL BATTLESHIP — Live Demo".padEnd(56) + "║");
  console.log("║" + "   Zama FHEVM  ·  Local Hardhat Mock".padEnd(56) + "║");
  console.log("╚" + line("═") + "╝");
  console.log();

  // ── Deploy ──────────────────────────────────────────────────────────────────
  console.log(line());
  console.log("  DEPLOY");
  console.log(line());

  const factory = (await ethers.getContractFactory("ConfidentialBattleship")) as ConfidentialBattleship__factory;
  const contract = await factory.deploy();
  const contractAddress = await contract.getAddress();

  console.log(`  Contract : ${contractAddress}`);
  console.log(`  Alice    : ${alice.address}`);
  console.log(`  Bob      : ${bob.address}`);
  console.log();

  // ── Create & join game ──────────────────────────────────────────────────────
  console.log(line());
  console.log("  SETUP GAME");
  console.log(line());

  const gameId = await contract.connect(alice).createGame.staticCall();
  await (await contract.connect(alice).createGame()).wait();
  console.log(`  Alice creates game #${gameId}`);

  await (await contract.connect(bob).joinGame(gameId)).wait();
  console.log(`  Bob   joins  game #${gameId}`);
  console.log();

  // ── Commit boards ───────────────────────────────────────────────────────────
  console.log(line());
  console.log("  BOARD COMMIT  (this is where FHE privacy kicks in)");
  console.log(line());

  const aliceBoard = boardBitmask(ALICE_SHIPS);
  console.log(`  Alice's ships : ${shipList(ALICE_SHIPS)}`);
  console.log(`  Plaintext     : ${aliceBoard} (a 25-bit bitmask — never sent in clear)`);
  const aliceEnc = await encryptBoard(contractAddress, alice.address, aliceBoard);
  await (await contract.connect(alice).commitBoard(gameId, aliceEnc.handle, aliceEnc.proof)).wait();
  const aliceBoardHandle = await contract.getBoard(gameId, 0);
  console.log(`  On-chain handle  →  ${aliceBoardHandle}`);
  console.log(`                       ↑ this is all the blockchain stores — encrypted, unreadable`);
  console.log();

  const bobBoard = boardBitmask(BOB_SHIPS);
  console.log(`  Bob's ships   : ${shipList(BOB_SHIPS)}`);
  console.log(`  Plaintext     : ${bobBoard} (never sent in clear)`);
  const bobEnc = await encryptBoard(contractAddress, bob.address, bobBoard);
  await (await contract.connect(bob).commitBoard(gameId, bobEnc.handle, bobEnc.proof)).wait();
  const bobBoardHandle = await contract.getBoard(gameId, 1);
  console.log(`  On-chain handle  →  ${bobBoardHandle}`);
  console.log(`                       ↑ opponent sees this — learns nothing about the board`);
  console.log();
  console.log(`  Both handles differ: ${aliceBoardHandle !== bobBoardHandle ? "YES ✓" : "NO ✗"}`);
  console.log(`  Game phase: ${await contract.getPhase(gameId)} (2 = Playing)`);
  console.log();

  // ── Gameplay ────────────────────────────────────────────────────────────────
  console.log(line());
  console.log("  GAMEPLAY  (coordinate is PUBLIC · result starts encrypted)");
  console.log(line());
  console.log("  Attacker  Cell    Result handle (encrypted)    Revealed");
  console.log("  " + line("-", 54));

  const shots: { attacker: string; shooter: typeof alice; x: number; y: number }[] = [
    { attacker: "Alice", shooter: alice, x: 1, y: 0 }, // Bob has ship here → HIT
    { attacker: "Bob  ", shooter: bob, x: 3, y: 0 }, // Alice has no ship  → MISS
    { attacker: "Alice", shooter: alice, x: 1, y: 1 }, // Bob has ship here → HIT
    { attacker: "Bob  ", shooter: bob, x: 2, y: 0 }, // Alice has no ship  → MISS
    { attacker: "Alice", shooter: alice, x: 3, y: 2 }, // Bob's 3rd ship    → HIT (winning)
  ];

  for (const shot of shots) {
    const { isHit, resultHandle } = await fireAndResolve(contract, shot.shooter, gameId, shot.x, shot.y);
    const label = isHit ? "HIT  ✓" : "MISS ✗";
    console.log(`  ${shot.attacker}   (${shot.x},${shot.y})   ${short(resultHandle)}   ${label}`);

    // Stop after the winning shot
    if ((await contract.getPhase(gameId)) === 3n) break;
  }

  console.log();

  // ── Result ──────────────────────────────────────────────────────────────────
  console.log(line());
  console.log("  GAME OVER");
  console.log(line());

  const winner = await contract.getWinner(gameId);
  const aliceHits = await contract.getHits(gameId, 0);
  const bobHits = await contract.getHits(gameId, 1);
  const winnerName = winner === alice.address ? "Alice" : "Bob";

  console.log(`  Winner  : ${winnerName} (${winner})`);
  console.log(`  Alice   : ${aliceHits} hit(s)`);
  console.log(`  Bob     : ${bobHits} hit(s)`);
  console.log();
  console.log("  What stayed private throughout:");
  console.log("    • Alice's full board layout — never revealed");
  console.log("    • Bob's full board layout   — never revealed");
  console.log("    • Only the fired cell's hit/miss was disclosed, one at a time");
  console.log();
  console.log(line("═"));
  console.log();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

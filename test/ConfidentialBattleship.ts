import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";
import { ConfidentialBattleship, ConfidentialBattleship__factory } from "../types";

// ── Board encoding ────────────────────────────────────────────────────────────
// Cell (x, y) maps to bit position (y*5 + x) in a 25-bit bitmask stored as euint32.
function boardBitmask(cells: [number, number][]): number {
  return cells.reduce((acc, [x, y]) => acc | (1 << (y * 5 + x)), 0);
}

// Alice's ships: (0,0) bit0=1, (2,1) bit7=128, (4,4) bit24=16777216
const ALICE_SHIPS: [number, number][] = [
  [0, 0],
  [2, 1],
  [4, 4],
];
const ALICE_BOARD = boardBitmask(ALICE_SHIPS);

// Bob's ships: (1,0) bit1=2, (1,1) bit6=64, (3,2) bit13=8192
const BOB_SHIPS: [number, number][] = [
  [1, 0],
  [1, 1],
  [3, 2],
];
const BOB_BOARD = boardBitmask(BOB_SHIPS);

// ── Types ─────────────────────────────────────────────────────────────────────
type Signers = {
  deployer: HardhatEthersSigner;
  alice: HardhatEthersSigner;
  bob: HardhatEthersSigner;
};

// ── Deploy fixture ────────────────────────────────────────────────────────────
async function deployFixture() {
  const factory = (await ethers.getContractFactory("ConfidentialBattleship")) as ConfidentialBattleship__factory;
  const contract = (await factory.deploy()) as ConfidentialBattleship;
  const contractAddress = await contract.getAddress();
  return { contract, contractAddress };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Encrypts a uint32 board value as an FHE encrypted input for the given player address.
async function encryptBoard(contractAddress: string, playerAddress: string, boardValue: number) {
  const enc = await fhevm.createEncryptedInput(contractAddress, playerAddress).add32(boardValue).encrypt();
  return { handle: enc.handles[0], proof: enc.inputProof };
}

// Commits an encrypted board and immediately calls verifyBoard to confirm the popcount == 3.
// Mirrors the two-step commit flow in the game server.
async function commitAndVerify(
  contract: ConfidentialBattleship,
  player: HardhatEthersSigner,
  contractAddress: string,
  gameId: bigint,
  playerIdx: number,
  boardValue: number,
): Promise<void> {
  const enc = await encryptBoard(contractAddress, player.address, boardValue);
  await (await contract.connect(player).commitBoard(gameId, enc.handle, enc.proof)).wait();

  const countHandle = await contract.getPendingBoardCount(gameId, playerIdx);
  const decryption = await fhevm.publicDecrypt([countHandle]);
  await (
    await contract.verifyBoard(
      gameId,
      playerIdx,
      [countHandle],
      decryption.abiEncodedClearValues,
      decryption.decryptionProof,
    )
  ).wait();
}

// Fires a shot, retrieves the mock KMS public decryption proof, and submits resolveShot.
// Returns true for hit, false for miss.
async function fireAndResolve(
  contract: ConfidentialBattleship,
  shooter: HardhatEthersSigner,
  gameId: bigint,
  x: number,
  y: number,
): Promise<boolean> {
  await (await contract.connect(shooter).fire(gameId, x, y)).wait();

  // getPendingResult returns the encrypted ebool handle as a bytes32 hex string
  const pendingHandle = await contract.getPendingResult(gameId);

  // The mock KMS decrypts the handle and returns the signed proof needed by resolveShot
  const decryption = await fhevm.publicDecrypt([pendingHandle]);

  // Anyone may call resolveShot — no msg.sender restriction in the contract
  await (
    await contract.resolveShot(gameId, [pendingHandle], decryption.abiEncodedClearValues, decryption.decryptionProof)
  ).wait();

  // KMS ABI-encodes booleans as uint256 (0 = miss, 1 = hit) — matching resolveShot's abi.decode
  const [rawResult] = ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], decryption.abiEncodedClearValues);
  return rawResult !== 0n;
}

// ── Test suite ────────────────────────────────────────────────────────────────
describe("ConfidentialBattleship", function () {
  let signers: Signers;
  let contract: ConfidentialBattleship;
  let contractAddress: string;

  before(async function () {
    const ethSigners = await ethers.getSigners();
    signers = {
      deployer: ethSigners[0],
      alice: ethSigners[1],
      bob: ethSigners[2],
    };
  });

  beforeEach(async function () {
    if (!fhevm.isMock) {
      console.warn("Tests require the local FHEVM mock — skipping on live network");
      this.skip();
    }
    ({ contract, contractAddress } = await deployFixture());
  });

  // Advances the game to Playing phase: creates a game, joins it, and both players commit
  // and verify boards (homomorphic popcount confirmed for both).
  async function setupGame(): Promise<bigint> {
    const gameId = await contract.connect(signers.alice).createGame.staticCall();
    await (await contract.connect(signers.alice).createGame()).wait();
    await (await contract.connect(signers.bob).joinGame(gameId)).wait();

    await commitAndVerify(contract, signers.alice, contractAddress, gameId, 0, ALICE_BOARD);
    await commitAndVerify(contract, signers.bob, contractAddress, gameId, 1, BOB_BOARD);

    return gameId;
  }

  // ── 1. Stored boards are opaque encrypted handles ─────────────────────────

  it("stored boards are opaque encrypted handles, not readable layouts", async function () {
    const id = await setupGame();

    const aliceHandle = await contract.getBoard(id, 0);
    const bobHandle = await contract.getBoard(id, 1);

    // Handles must be set (non-zero) after commit
    expect(aliceHandle).to.not.eq(ethers.ZeroHash);
    expect(bobHandle).to.not.eq(ethers.ZeroHash);

    // The raw handle bytes32 must not be the plaintext board value — it is an opaque ciphertext pointer
    expect(BigInt(aliceHandle)).to.not.eq(BigInt(ALICE_BOARD));
    expect(BigInt(bobHandle)).to.not.eq(BigInt(BOB_BOARD));

    // The two handles are distinct even though both are encrypted uint32 values
    expect(aliceHandle).to.not.eq(bobHandle);
  });

  // ── 2. Owner can decrypt their board; opponent cannot ─────────────────────

  it("player can decrypt their own board but the opponent is ACL-rejected", async function () {
    const id = await setupGame();

    const aliceHandle = await contract.getBoard(id, 0);

    // Alice decrypts her own board — must recover the exact plaintext she committed
    const clearAlice = await fhevm.userDecryptEuint(FhevmType.euint32, aliceHandle, contractAddress, signers.alice);
    expect(clearAlice).to.eq(BigInt(ALICE_BOARD));

    // Bob attempts to decrypt Alice's board — the KMS must reject him (no FHE.allow for Bob)
    let opponentDecryptFailed = false;
    try {
      await fhevm.userDecryptEuint(FhevmType.euint32, aliceHandle, contractAddress, signers.bob);
    } catch {
      opponentDecryptFailed = true;
    }
    expect(opponentDecryptFailed, "Opponent must not be able to decrypt Alice's board").to.equal(true);
  });

  // ── 3. fire() reveals only the targeted cell's hit/miss ───────────────────

  it("fire() reveals hit for an occupied cell and miss for an empty cell; the board itself stays encrypted", async function () {
    const id = await setupGame();

    // Alice fires at (1,0) — Bob has a ship there → hit
    const hit = await fireAndResolve(contract, signers.alice, id, 1, 0);
    expect(hit, "shot at occupied cell must be a hit").to.equal(true);

    // Turn passes to Bob. Bob fires at (3,0) — Alice has no ship there → miss
    const miss = await fireAndResolve(contract, signers.bob, id, 3, 0);
    expect(miss, "shot at empty cell must be a miss").to.equal(false);

    // Privacy proof: Bob's full board handle was NOT marked makePubliclyDecryptable.
    // Only the individual shot ebool was. Attempting public decryption of the board handle must fail.
    const bobBoardHandle = await contract.getBoard(id, 1);
    let boardPublicDecryptFailed = false;
    try {
      await fhevm.publicDecryptEuint(FhevmType.euint32, bobBoardHandle);
    } catch {
      boardPublicDecryptFailed = true;
    }
    expect(boardPublicDecryptFailed, "Board handle must not be publicly decryptable").to.equal(true);
  });

  // ── 4. Homomorphic popcount rejects invalid boards ────────────────────────

  it("verifyBoard rejects a board with 0 ships and a board with too many ships", async function () {
    for (const cheatBoard of [0, 0b11111_11111_11111_11111_11111]) {
      const gameId = await contract.connect(signers.alice).createGame.staticCall();
      await (await contract.connect(signers.alice).createGame()).wait();
      await (await contract.connect(signers.bob).joinGame(gameId)).wait();

      const enc = await encryptBoard(contractAddress, signers.alice.address, cheatBoard);
      await (await contract.connect(signers.alice).commitBoard(gameId, enc.handle, enc.proof)).wait();

      const countHandle = await contract.getPendingBoardCount(gameId, 0);
      const decryption = await fhevm.publicDecrypt([countHandle]);

      await expect(
        contract.verifyBoard(gameId, 0, [countHandle], decryption.abiEncodedClearValues, decryption.decryptionProof),
      ).to.be.revertedWith("Board must have exactly 3 ships");
    }
  });

  // ── 5. Full game plays to a winner ────────────────────────────────────────

  it("plays a complete game and declares the correct winner after 3 hits", async function () {
    const id = await setupGame();

    // Phase must be Playing (2) after both boards are committed and verified
    expect(await contract.getPhase(id)).to.eq(2n);

    // Alice targets Bob's three ships one by one.
    // Between each of Alice's turns, Bob fires at an empty cell on Alice's board.
    //
    // Bob's ships: (1,0), (1,1), (3,2)
    // Alice's empty cells Bob fires at: (3,0), (2,0) — neither is in Alice's ship list

    // Round 1
    expect(await fireAndResolve(contract, signers.alice, id, 1, 0)).to.equal(true); // Alice hits (1,0)
    expect(await fireAndResolve(contract, signers.bob, id, 3, 0)).to.equal(false); // Bob misses (3,0)

    // Round 2
    expect(await fireAndResolve(contract, signers.alice, id, 1, 1)).to.equal(true); // Alice hits (1,1)
    expect(await fireAndResolve(contract, signers.bob, id, 2, 0)).to.equal(false); // Bob misses (2,0)

    // Round 3 — Alice's 3rd hit ends the game; turn does NOT advance after the winning shot
    expect(await fireAndResolve(contract, signers.alice, id, 3, 2)).to.equal(true); // Alice hits (3,2)

    // Game must now be Finished (3)
    expect(await contract.getPhase(id)).to.eq(3n);
    expect(await contract.getWinner(id)).to.eq(signers.alice.address);
    expect(await contract.getHits(id, 0)).to.eq(3n); // Alice (index 0) scored 3 hits
    expect(await contract.getHits(id, 1)).to.eq(0n); // Bob scored 0 hits
  });
});

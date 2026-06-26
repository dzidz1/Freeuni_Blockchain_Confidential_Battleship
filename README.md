# Confidential Battleship on Zama FHEVM

**Course:** Blockchain Technologies — Privacy on Blockchain **Primitive:** Fully Homomorphic Encryption (FHE) via Zama
FHEVM **Platform:** Path B — compose on an existing FHE platform **Sepolia contract:**
[`0x8EB70ab88976ae9fD800395213a08d65bbd9E0a8`](https://sepolia.etherscan.io/address/0x8EB70ab88976ae9fD800395213a08d65bbd9E0a8#code)

---

## 1. What it does

Battleship is unplayable on a normal blockchain. All contract storage is public, so an opponent can read your board
directly from chain state and aim with perfect information. The game is broken at the protocol level.

This project fixes that with FHE. Each player's board is stored **encrypted on-chain** as a `euint32` ciphertext. When a
shot is fired, the contract runs the hit/miss computation **directly on the ciphertext** — it never decrypts the board.
It produces a single encrypted boolean (hit or miss) for the targeted cell and makes only that boolean public. Every
other cell stays encrypted.

The result: an observer can see who joined, who fired, and where — but never the board layout itself. You learn your
opponent's ship positions only by spending shots, exactly as the physical game intends.

### Board rules

- 5×5 grid, 25 cells
- Each player secretly marks exactly **3 occupied cells** (ships)
- Players alternate firing at one cell per turn
- A shot reveals only hit or miss for that cell — nothing else
- First player to hit all 3 of the opponent's cells wins

### What is private vs. public

| Data                                     | Visibility                                              |
| ---------------------------------------- | ------------------------------------------------------- |
| A player's board layout                  | **Private** — encrypted handle on-chain, never readable |
| The fact that a player joined            | Public                                                  |
| The fact that a player committed a board | Public                                                  |
| A shot's coordinate (x, y)               | Public — announced when fired                           |
| Hit / miss result of a fired cell        | Public — intentionally revealed, one cell at a time     |
| All un-fired cells                       | **Private** — never revealed                            |
| Winner                                   | Public — announced at game end                          |

---

## 2. Why FHE — and not ZK, MPC, or TEE

The core requirement is: **the contract must compute on data it is not allowed to see.** Given a public shot coordinate,
it must check the encrypted board and return only the result for that cell. This rules out most privacy primitives for
different reasons.

### Zero-knowledge proofs (ZK)

ZK proofs let you prove a statement about secret data without revealing the data. They are useful at commit time — you
could prove "I placed exactly 3 ships in valid positions" without revealing where. But ZK alone cannot maintain **hidden
mutable state** across turns. For each shot, someone would need to know the plaintext board to generate a proof that
cell (x, y) is hit. That someone is a trusted party — which defeats the purpose of an on-chain game.

ZK is complementary to FHE (a homomorphic board validity proof is a known extension) but cannot replace it as the core
mechanism.

### Multi-party computation (MPC)

MPC distributes the computation across multiple nodes so no single node sees the plaintext. In principle, MPC could
compute hit/miss jointly. In practice, it requires all participating nodes to be online and cooperative for every shot.
A single node going offline stalls the game. It also requires more infrastructure — multiple non-colluding servers —
compared to FHEVM, which piggybacks on the existing blockchain validators. The liveness guarantees are weaker and the
operational cost is higher.

### Trusted Execution Environments (TEE)

A TEE (Intel SGX, AWS Nitro Enclaves) runs code in a hardware-isolated enclave. The board could live as plaintext inside
the enclave and only the hit/miss result would exit. The trust model is: "trust that Intel's or Amazon's hardware
implementation has no exploitable vulnerabilities." In practice, TEEs have a poor track record — Spectre, Meltdown,
Foreshadow, SGX side-channel attacks, and Plundervolt have all broken the isolation guarantee at various points. The
trust assumption is "trust a hardware vendor's engineers and their supply chain" rather than mathematical hardness.

### FHE — the chosen primitive

FHE keeps the board **encrypted at rest and during computation**. The contract performs arithmetic directly on
ciphertexts using the FHEVM coprocessor. No extra nodes are needed beyond the existing blockchain infrastructure. The
trust model inherits from Zama's threshold KMS: decryption requires a threshold of independent key-holders to cooperate,
and no single party — not even a validator — can read a board unilaterally.

The fit is exact: FHE was designed for exactly the problem of computing on data you cannot see.

---

## 3. Architecture

```
Player A (client script / UI)
  │
  │  1. encrypt board client-side:
  │     fhevm.createEncryptedInput(contract, playerA).add32(bitmask).encrypt()
  │     → { handle: bytes32, proof: bytes }
  │
  ▼
ConfidentialBattleship.sol  (Zama FHEVM contract)
  │
  │  2. commitBoard: FHE.fromExternal(handle, proof) → euint32
  │     ACL: FHE.allowThis (contract can compute on it)
  │          FHE.allow(owner) (owner can decrypt their own board)
  │          (opponent has NO allow — cannot decrypt)
  │
  │  3. fire(x, y): coordinate is PUBLIC
  │     bitIndex = y * 5 + x
  │     shifted  = FHE.shr(board, bitIndex)   // board >> bitIndex
  │     masked   = FHE.and(shifted, 1)         // keep only bit 0
  │     isHit    = FHE.ne(masked, 0)           // encrypted boolean
  │     FHE.makePubliclyDecryptable(isHit)     // mark this one boolean for reveal
  │     → stores isHit as pendingResult (still encrypted)
  │
  │  4. resolveShot: caller submits KMS-signed plaintext + proof
  │     FHE.checkSignatures(handles, abiEncodedResult, decryptionProof)
  │     → reveals isHit as plaintext bool; updates hitsScored; flips turn
  │
  │  5. track hits per attacker; 3 hits → Finished; record winner
  ▼
Public outputs: hit/miss per fired cell, winner at game end
Private forever: every un-fired cell of both boards
```

### Board encoding

The 5×5 grid is packed into a single `euint32` (25 bits used). Cell (x, y) occupies bit position `y * 5 + x`:

```
(0,0)=bit0  (1,0)=bit1  (2,0)=bit2  (3,0)=bit3  (4,0)=bit4
(0,1)=bit5  (1,1)=bit6  (2,1)=bit7  ...
...
(4,4)=bit24
```

A board with ships at (0,0), (2,1), (4,4) has bits 0, 7, and 24 set: `1 + 128 + 16,777,216 = 16,777,345` — this number
is encrypted before being sent anywhere.

### The two-transaction shot flow

A shot takes two transactions because the FHE coprocessor needs a block boundary to produce the decryption proof:

1. **`fire(x, y)`** — computes hit/miss on the encrypted board using three FHE operations (`shr`, `and`, `ne`), stores
   the encrypted result as `pendingResult`, marks it publicly decryptable. No plaintext is revealed yet.
2. **`resolveShot(...)`** — caller submits the KMS-signed decryption. The contract verifies the signatures on-chain via
   `FHE.checkSignatures`, decodes the plaintext boolean, updates hit counts and turn. Anyone may call this (there is no
   `msg.sender` restriction).

### Tech stack

| Layer                | Technology                                                           |
| -------------------- | -------------------------------------------------------------------- |
| Contract language    | Solidity `^0.8.27`                                                   |
| FHE library          | `@fhevm/solidity` — `FHE.sol`, `euint32`, `ebool`, `externalEuint32` |
| Dev / test framework | Hardhat + `@fhevm/hardhat-plugin` (local mock)                       |
| Client encryption    | `fhevm.createEncryptedInput()` from the Hardhat plugin               |
| Test runner          | Mocha + Chai + `@nomicfoundation/hardhat-chai-matchers`              |
| TypeScript types     | TypeChain (auto-generated from ABI)                                  |
| Starter template     | `zama-ai/fhevm-hardhat-template`                                     |

---

## 4. How to run

### Prerequisites

- Node.js 20 or 22 (even versions only — Hardhat dislikes odd releases)
- npm 7+

### Install

```bash
npm install
```

### Run the tests

```bash
npx hardhat test
```

Expected output — all five tests green:

```
  ConfidentialBattleship
    ✔ stored boards are opaque encrypted handles, not readable layouts
    ✔ player can decrypt their own board but the opponent is ACL-rejected
    ✔ fire() reveals hit for an occupied cell and miss for an empty cell; the board itself stays encrypted
    ✔ verifyBoard rejects a board with 0 ships and a board with too many ships
    ✔ plays a complete game and declares the correct winner after 3 hits

  5 passing
```

### Run the live demo

```bash
# Terminal 1 — keep this running
npx hardhat node

# Terminal 2 — run the demo script
npx hardhat run scripts/demo.ts --network localhost
```

The demo deploys a fresh contract, commits two encrypted boards, prints the raw on-chain handles (unreadable gibberish),
plays five shots with hit/miss revealed per shot, and announces the winner.

### Play the game (browser UI)

```bash
# Terminal 1 — keep this running
npx hardhat node

# Terminal 2 — starts a game server that deploys a fresh contract
npx hardhat task:ui-server --network localhost
```

Then open **http://localhost:3001** in any browser.

The UI is hot-seat multiplayer on a single machine:

1. Click **Create Game** (Alice) — note the Game ID shown in the header
2. Place Alice's 3 ships, click **Encrypt & Commit Board**
3. The UI automatically switches to Bob's placement screen
4. Place Bob's 3 ships, click **Encrypt & Commit Board**
5. The game starts — Alice goes first; after each shot click **Switch player** to hand the keyboard to the other player
6. First to hit all 3 enemy ships wins

---

## 5. Contract walkthrough

`contracts/ConfidentialBattleship.sol` has four lifecycle phases:

```
Waiting → Committing → Playing → Finished
```

Every function opens with a `require(phase == ...)` guard — nothing can skip a phase.

### `commitBoard` + `verifyBoard`

```solidity
euint32 board = FHE.fromExternal(encBoard, inputProof);
FHE.allowThis(board);         // contract can use it in fire()
FHE.allow(board, msg.sender); // owner can decrypt their own board
// opponent has no FHE.allow → cannot decrypt
```

`FHE.fromExternal` verifies the zero-knowledge input proof and converts the client-side ciphertext into an on-chain
handle. The ACL grants are permanent and precise: the contract gets compute access; the owner gets read access; nobody
else gets anything.

After storing the board, `commitBoard` immediately computes a **homomorphic popcount** — summing all 25 bits using
`FHE.shr`, `FHE.and`, and `FHE.add`, entirely on the ciphertext. The encrypted count is marked publicly decryptable. The
caller then submits `verifyBoard` with the KMS-signed plaintext; the contract checks `count == SHIP_COUNT` and reverts
if not. A cheating board is rejected before the game starts. Crucially, only the **count** is ever decrypted — the
positions remain encrypted throughout.

### `fire` — the privacy core

```solidity
uint8 bitIndex = y * BOARD_SIZE + x;

euint32 shifted = FHE.shr(g.boards[defenderIdx], bitIndex);
euint32 masked  = FHE.and(shifted, uint32(1));
ebool   isHit   = FHE.ne(masked, uint32(0));
```

Three FHE operations run entirely on the ciphertext. No plaintext branch on the secret board. The result is a new
encrypted boolean. Only this boolean — not the board — is marked publicly decryptable:

```solidity
FHE.makePubliclyDecryptable(isHit); // one cell's result, nothing else
```

### `resolveShot`

```solidity
FHE.checkSignatures(handles, abiEncodedResult, decryptionProof);
bool isHit = abi.decode(abiEncodedResult, (uint256)) != 0;
```

The KMS proof is verified on-chain. Only then is the result decoded and written as plaintext (`hitsScored`). It is safe
to store hit counts in plaintext because hits are publicly revealed one at a time as the game progresses — no
accumulated information leaks.

---

## 6. Tests — proving the privacy properties

`test/ConfidentialBattleship.ts` contains five tests, each proving a specific privacy or correctness claim.

### Test 1 — Boards are opaque handles

After both players commit their boards, `getBoard()` returns a `bytes32` handle. The test asserts the handle is
non-zero, is not equal to the plaintext board value, and that the two players' handles are distinct. The raw storage
reveals nothing about the layout.

### Test 2 — ACL: owner can decrypt, opponent cannot

Alice calls `fhevm.userDecryptEuint()` on her board handle and recovers the exact plaintext she committed. Bob attempts
the same call — the mock KMS throws because Bob was never given `FHE.allow`. This is the privacy money-shot: the test
proves the ACL enforcement is real.

### Test 3 — Only the fired cell is revealed

A shot at an occupied cell returns hit; a shot at an empty cell returns miss. After both shots, the test calls
`fhevm.publicDecryptEuint()` on the board handle itself — this throws, because the board was never given
`FHE.makePubliclyDecryptable`. Only the individual shot's `ebool` was. The board's un-fired cells stay encrypted.

### Test 4 — Homomorphic popcount rejects cheating boards

A board with 0 ships and a board with 25 ships are each committed and their encrypted popcounts are decrypted via the
mock KMS. `verifyBoard` is called with the KMS proof and must revert with "Board must have exactly 3 ships" in both
cases.

### Test 5 — Full game to a winner

Alice hits all three of Bob's ships across three rounds (Bob fires empty cells in between). After Alice's third hit, the
test asserts phase is `Finished`, winner is Alice's address, and hit counts are correct for both players.

---

## 7. Threat model

### Actors

| Actor              | Description                                                         |
| ------------------ | ------------------------------------------------------------------- |
| **Player**         | Commits a secret board; wants their layout hidden from the opponent |
| **Opponent**       | The other player; an adversary with respect to your board           |
| **Chain observer** | Anyone reading chain state, the mempool, or a block explorer        |
| **FHEVM KMS**      | Off-chain threshold committee holding the FHE master keys           |

### Who sees what

|                    | Board layout             | Who joined / fired | Shot coordinate | Hit/miss of fired cell | Un-fired cells |
| ------------------ | ------------------------ | ------------------ | --------------- | ---------------------- | -------------- |
| **Chain observer** | No — handle only         | Yes                | Yes             | Yes                    | No             |
| **Opponent**       | No                       | Yes                | Yes             | Yes                    | No             |
| **Board owner**    | Yes (own only)           | Yes                | Yes             | Yes                    | Yes (own only) |
| **KMS committee**  | Only what ACL authorizes | Yes                | Yes             | Yes                    | No             |

### Trust assumptions

1. **FHE soundness** — Zama's TFHE library keeps ciphertexts confidential.
2. **Threshold KMS** — decryption requires a threshold of key-holders to cooperate. Confidentiality holds unless that
   threshold colludes. No single party is trusted alone.
3. **ACL correctness** — a board is decryptable only by its owner (`FHE.allow`) and usable only by the contract
   (`FHE.allowThis`). The entire privacy design reduces to getting these two grants right: a missing grant is a liveness
   bug; an over-broad grant is a confidentiality bug.
4. **Contract is the referee** — hit/miss and the winner are decided by on-chain FHE computation, not by any off-chain
   adjudicator.

### What is protected

- The opponent cannot read your board layout. They learn a cell's contents only by spending a shot on it.
- Raw chain state reveals only encrypted handles. Inspecting storage leaks nothing.
- Neither player can peek to gain an unfair advantage, because neither is on the other's board ACL.
- The hit/miss computation runs entirely in FHE — no plaintext branch on the secret board.

### What is NOT protected

**Move metadata.** Who joined, who fired, and which coordinates were fired are all public. We hide board _contents_, not
the fact of play. A statistical analysis of shot patterns over many games could in principle narrow down opponent ship
locations, though within a single game this is just the normal information gained by spending shots.

**Honest board setup.** The contract enforces exactly 3 occupied bits via a homomorphic popcount checked at commit time.
A cheating board (0 ships, 25 ships, etc.) is rejected by `verifyBoard` before the game can start.

**Liveness / griefing.** A losing player can stall by refusing to take their turn. There is no per-turn timeout.
Mitigation: a deadline after which the waiting player can claim the win. Not implemented — listed as a known gap.

**KMS trust.** Board confidentiality ultimately rests on the threshold key-holders not colluding. This is the platform's
trust root, inherited from Zama's infrastructure and not removed by this application.

---

## 8. Limitations and known gaps

| Gap                     | Impact                                 | Mitigation                                                          |
| ----------------------- | -------------------------------------- | ------------------------------------------------------------------- |
| No per-turn timeout     | Losing player can stall indefinitely   | On-chain deadline + claim-win function (not implemented)            |
| KMS threshold trust     | Collusion breaks board confidentiality | Inherited platform assumption — no workaround at app level          |
| Move metadata is public | Shot patterns are observable           | Inherent to on-chain play; not fixable without off-chain components |

---

## 9. Project structure

```
contracts/
  ConfidentialBattleship.sol   # The FHE game contract
  FHECounter.sol               # Template example (unchanged)

test/
  ConfidentialBattleship.ts    # 5 privacy-proving tests
  FHECounter.ts                # Template example tests

scripts/
  demo.ts                      # End-to-end scripted demo

tasks/
  BattleshipServer.ts          # Hardhat task: browser game server
  FHECounter.ts                # Template example tasks

ui/
  index.html                   # Browser game UI (hot-seat multiplayer)

deploy/
  deploy.ts                    # Deployment script

PROPOSAL.md                    # Original project proposal
THREAT_MODEL.md                # Full threat model
```

---

## 10. License

BSD-3-Clause-Clear — see [LICENSE](LICENSE).

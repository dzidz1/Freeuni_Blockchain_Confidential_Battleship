# Threat Model — Confidential Battleship on FHEVM

States **who sees what, who we trust, and what is and isn't protected.** Half the grade (privacy correctness + crypto
choices) rests on this matching the implementation, so it deliberately names the limits too.

## 1. Actors

- **Player** — commits a secret board; wants their layout hidden from the opponent until cells are fired at.
- **Opponent** — the other player; an adversary with respect to your board.
- **Chain observer** — anyone reading the ledger, mempool, or explorer.
- **FHEVM key-management infrastructure (KMS)** — the off-chain threshold committee holding the FHE keys; performs
  decryption only when the ACL authorizes it. Inherited platform trust.

## 2. What each actor can see

|                    | Board layout                    | Who joined / fired | Shot coordinate | Hit/miss of a fired cell | Un-fired cells |
| ------------------ | ------------------------------- | ------------------ | --------------- | ------------------------ | -------------- |
| **Chain observer** | ❌ handle only                  | ✅                 | ✅              | ✅                       | ❌             |
| **Opponent**       | ❌                              | ✅                 | ✅              | ✅                       | ❌             |
| **Board owner**    | ✅ (own)                        | ✅                 | ✅              | ✅                       | ✅ (own)       |
| **KMS committee**  | ⚠️ only what the ACL authorizes | ✅                 | ✅              | ✅                       | ❌             |

Intended guarantee: **board confidentiality** (layout hidden) with **selective disclosure** of exactly the cells that
get fired at, and **outcome integrity** (hits/wins decided by the contract, not a privileged party).

## 3. Trust assumptions

1. **FHE soundness** — Zama's TFHE keeps ciphertexts confidential.
2. **Threshold KMS** — decryption needs a threshold of key-holders; confidentiality holds unless that threshold
   colludes. No single key-holder is trusted.
3. **ACL correctness** — a board is decryptable only by its owner (`FHE.allow`) and usable by the contract
   (`FHE.allowThis`). The whole design reduces to getting these grants right: a missing grant is a liveness bug; an
   over-broad grant is a confidentiality bug.
4. **Contract is the referee** — hit/miss and the winner are decided by computation on the encrypted board; no off-chain
   adjudicator.

## 4. What is protected

- The opponent (and any observer) cannot read your board; they learn a cell's contents only by **spending a shot** on
  it, and learn nothing about the others.
- Raw on-chain storage reveals only encrypted handles — inspecting state leaks nothing.
- Neither player can peek to gain an unfair advantage, because neither is on the other's board ACL.

## 5. What is NOT protected (state these honestly in the demo)

- **Move metadata.** Who joined, who fired, and the coordinates fired at are public. We hide board _contents_, not the
  fact of play.
- **Honest board setup.** A player could commit an invalid board (e.g., wrong number of occupied cells). Mitigation: a
  homomorphic popcount is computed on the encrypted board at commit time and verified on-chain by `verifyBoard` — the
  game refuses to start if the count is not exactly 3. Implemented.
- **Liveness / griefing.** A losing player can stall by not taking their turn. Mitigation: a per-turn timeout after
  which the waiting player can claim the game.
- **KMS trust.** Confidentiality ultimately rests on the threshold key-holders not colluding — the platform's trust
  root, inherited, not removed.
- **Side channels.** Branching on decrypted values could leak info; the design reveals only the intended hit/miss
  boolean and avoids plaintext branches on the secret board (uses FHE comparison/selection).

## 6. Attacker scenarios (and the defense)

- **Opponent reads your board to aim perfectly** → board stored as ciphertext, decryptable only by you; opponent not on
  its ACL. Defended.
- **Observer scrapes chain state for layouts** → only encrypted handles on-chain. Defended.
- **Player commits a cheating board (e.g., 0 ships so it can't be hit)** → `verifyBoard` computes the encrypted popcount
  of all 25 bits and checks it equals exactly 3 on-chain. The transaction reverts for any invalid board. Defended.
- **Single key-holder tries to decrypt a board** → threshold scheme needs t-of-n collusion. Defended under the threshold
  assumption.
- **Stalling to avoid a loss** → per-turn timeout lets the opponent claim the win. Defended if implemented.

## 7. Summary statement for the slides

> We protect **board confidentiality** and **outcome integrity**, assuming the FHE scheme is sound and the KMS threshold
> isn't breached. We do **not** hide who plays or where they fire, and confidentiality rests on the threshold committee.
> The trust we removed: no opponent or observer can read your board. The trust we kept: Zama's threshold key-holders.

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FHE, euint32, ebool, externalEuint32} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";

/// @title Confidential Battleship — 5x5 board, 3 ships, FHE-hidden boards
/// @notice Each player's board is stored encrypted. A shot coordinate is public;
///         only the hit/miss boolean for that cell is ever revealed via public decryption.
///         The rest of the board stays secret.
///         Board validity (exactly SHIP_COUNT ships) is enforced homomorphically:
///         commitBoard computes an encrypted popcount; verifyBoard decrypts and checks it.
contract ConfidentialBattleship is ZamaEthereumConfig {
    uint8 public constant BOARD_SIZE = 5; // 5x5 grid
    uint8 public constant SHIP_COUNT = 3; // 3 occupied cells per board

    enum Phase {
        Waiting,
        Committing,
        Playing,
        Finished
    }

    struct Game {
        address[2] players;
        euint32[2] boards; // encrypted 25-bit bitmask: bit (y*5+x) = 1 means occupied
        uint8[2] hitsScored; // plaintext hit count per attacker; safe because hits are publicly revealed
        uint8 turn; // index (0 or 1) of the player who fires next
        address winner;
        Phase phase;
        uint8 boardsIn; // how many boards committed so far (0, 1, 2)
        // Board validity: commitBoard computes encrypted popcount; verifyBoard checks it == SHIP_COUNT
        euint32[2] pendingBoardCount; // encrypted popcount per player, publicly decryptable
        bool[2] boardVerified; // true once verifyBoard confirms exactly SHIP_COUNT ships
        // Pending unresolved shot — must call resolveShot before the next fire()
        bool hasPending;
        uint8 pendingAttacker;
        uint8 pendingX;
        uint8 pendingY;
        ebool pendingResult; // encrypted hit/miss handle; publicly decryptable via KMS
    }

    uint256 public nextGameId;

    // Storage is private; getters expose only what each caller is entitled to see.
    mapping(uint256 => Game) private _games;

    // Tracks which cells each attacker has already fired at: gameId→attacker→y→x→fired
    mapping(uint256 => mapping(uint8 => mapping(uint8 => mapping(uint8 => bool)))) private _fired;

    event GameCreated(uint256 indexed gameId, address player0);
    event GameJoined(uint256 indexed gameId, address player1);
    event BoardCommitted(uint256 indexed gameId, uint8 playerIdx);
    event BoardVerified(uint256 indexed gameId, uint8 playerIdx);
    event ShotFired(uint256 indexed gameId, uint8 attackerIdx, uint8 x, uint8 y, bytes32 resultHandle);
    event ShotResolved(uint256 indexed gameId, uint8 attackerIdx, uint8 x, uint8 y, bool isHit);
    event GameOver(uint256 indexed gameId, address winner);

    // ── Game lifecycle ──────────────────────────────────────────────────────

    function createGame() external returns (uint256 id) {
        id = nextGameId++;
        Game storage g = _games[id];
        g.players[0] = msg.sender;
        g.phase = Phase.Waiting;
        emit GameCreated(id, msg.sender);
    }

    function joinGame(uint256 id) external {
        Game storage g = _games[id];
        require(g.phase == Phase.Waiting, "Not open");
        require(msg.sender != g.players[0], "Already player 0");
        g.players[1] = msg.sender;
        g.phase = Phase.Committing;
        emit GameJoined(id, msg.sender);
    }

    /// @notice Commit an encrypted board and compute its encrypted popcount.
    ///         The popcount is marked publicly decryptable so verifyBoard can confirm
    ///         it equals exactly SHIP_COUNT without ever revealing the board layout.
    function commitBoard(uint256 id, externalEuint32 encBoard, bytes calldata inputProof) external {
        Game storage g = _games[id];
        require(g.phase == Phase.Committing, "Not committing");
        uint8 idx = _playerIdx(g, msg.sender);
        require(!FHE.isInitialized(g.boards[idx]), "Board already committed");

        euint32 board = FHE.fromExternal(encBoard, inputProof);
        g.boards[idx] = board;

        // Contract needs the handle to compute shots; owner can decrypt their own board
        FHE.allowThis(board);
        FHE.allow(board, msg.sender);

        // Homomorphic popcount: sum all 25 bits of the encrypted board
        euint32 count = _popcount25(board);
        FHE.allowThis(count);
        FHE.makePubliclyDecryptable(count); // caller must follow up with verifyBoard
        g.pendingBoardCount[idx] = count;

        g.boardsIn++;
        // Phase transition happens in verifyBoard once both counts are confirmed
        emit BoardCommitted(id, idx);
    }

    /// @notice Submit the KMS-signed decryption of the board's popcount.
    ///         Reverts if the count is not exactly SHIP_COUNT — the board is rejected.
    ///         Once both players' boards are verified the game advances to Playing.
    /// @param handles          Must be [euint32.unwrap(pendingBoardCount[playerIdx])]
    /// @param abiEncodedResult ABI-encoded uint256 (the decrypted popcount) signed by KMS
    /// @param decryptionProof  KMS threshold signatures proving the plaintext is correct
    function verifyBoard(
        uint256 id,
        uint8 playerIdx,
        bytes32[] memory handles,
        bytes memory abiEncodedResult,
        bytes memory decryptionProof
    ) external {
        Game storage g = _games[id];
        require(g.phase == Phase.Committing, "Not committing");
        require(playerIdx < 2, "Invalid player index");
        require(FHE.isInitialized(g.boards[playerIdx]), "Board not committed");
        require(!g.boardVerified[playerIdx], "Already verified");

        require(handles.length == 1 && handles[0] == euint32.unwrap(g.pendingBoardCount[playerIdx]), "Handle mismatch");

        // Verify KMS signatures on-chain: reverts if invalid
        FHE.checkSignatures(handles, abiEncodedResult, decryptionProof);

        uint256 count = abi.decode(abiEncodedResult, (uint256));
        require(count == SHIP_COUNT, "Board must have exactly 3 ships");

        g.boardVerified[playerIdx] = true;
        emit BoardVerified(id, playerIdx);

        if (g.boardVerified[0] && g.boardVerified[1]) {
            g.phase = Phase.Playing;
        }
    }

    // ── Gameplay ────────────────────────────────────────────────────────────

    /// @notice Fire at cell (x, y) on the opponent's encrypted board.
    ///         The result is an encrypted boolean stored on-chain and marked for public
    ///         decryption. Call resolveShot() with the KMS-signed decryption to advance state.
    function fire(uint256 id, uint8 x, uint8 y) external {
        Game storage g = _games[id];
        require(g.phase == Phase.Playing, "Not playing");
        require(x < BOARD_SIZE && y < BOARD_SIZE, "Out of bounds");
        require(!g.hasPending, "Resolve previous shot first");

        uint8 attackerIdx = _playerIdx(g, msg.sender);
        require(attackerIdx == g.turn, "Not your turn");
        require(!_fired[id][attackerIdx][y][x], "Cell already targeted");

        uint8 defenderIdx = 1 - attackerIdx;
        uint8 bitIndex = y * BOARD_SIZE + x;

        // Isolate bit at position bitIndex in the defender's encrypted board:
        //   shifted = board >> bitIndex
        //   masked  = shifted & 1
        //   isHit   = (masked != 0)
        // No plaintext branch on the secret board — all computation is FHE.
        euint32 shifted = FHE.shr(g.boards[defenderIdx], bitIndex);
        euint32 masked = FHE.and(shifted, uint32(1));
        ebool isHit = FHE.ne(masked, uint32(0));

        // Grant decryption access: contract (for resolveShot), both players, and public KMS path.
        FHE.allowThis(isHit);
        FHE.allow(isHit, g.players[0]);
        FHE.allow(isHit, g.players[1]);
        FHE.makePubliclyDecryptable(isHit); // enables fhevm.publicDecrypt / checkSignatures flow

        _fired[id][attackerIdx][y][x] = true;

        g.hasPending = true;
        g.pendingAttacker = attackerIdx;
        g.pendingX = x;
        g.pendingY = y;
        g.pendingResult = isHit;

        emit ShotFired(id, attackerIdx, x, y, ebool.unwrap(isHit));
    }

    /// @notice Submit the KMS-signed plaintext decryption of the last shot's result.
    ///         Anyone may call this once the KMS proof is available (typically immediately
    ///         on the local mock via fhevm.publicDecrypt).
    /// @param handles            Must be [ebool.unwrap(pendingResult)] — verified on-chain.
    /// @param abiEncodedResult   ABI-encoded uint256 (0 = miss, 1 = hit) signed by KMS.
    /// @param decryptionProof    KMS threshold signatures proving the plaintext is correct.
    function resolveShot(
        uint256 id,
        bytes32[] memory handles,
        bytes memory abiEncodedResult,
        bytes memory decryptionProof
    ) external {
        Game storage g = _games[id];
        require(g.phase == Phase.Playing, "Not playing");
        require(g.hasPending, "No pending shot");

        // Bind the provided handle to the stored result to prevent handle substitution.
        require(handles.length == 1 && handles[0] == ebool.unwrap(g.pendingResult), "Handle mismatch");

        // Verify KMS signatures: reverts if invalid, emits PublicDecryptionVerified if ok.
        FHE.checkSignatures(handles, abiEncodedResult, decryptionProof);

        // Decode plaintext. KMS always ABI-encodes booleans as uint256 (0 or 1).
        uint256 rawResult = abi.decode(abiEncodedResult, (uint256));
        bool isHit = rawResult != 0;

        uint8 attackerIdx = g.pendingAttacker;
        uint8 x = g.pendingX;
        uint8 y = g.pendingY;
        g.hasPending = false;

        emit ShotResolved(id, attackerIdx, x, y, isHit);

        if (isHit) {
            g.hitsScored[attackerIdx]++;
            if (g.hitsScored[attackerIdx] >= SHIP_COUNT) {
                g.phase = Phase.Finished;
                g.winner = g.players[attackerIdx];
                emit GameOver(id, g.winner);
                return; // turn does not advance; game is over
            }
        }

        g.turn = 1 - g.turn; // pass the turn to the other player
    }

    // ── View helpers ─────────────────────────────────────────────────────────

    function getPhase(uint256 id) external view returns (Phase) {
        return _games[id].phase;
    }
    function getWinner(uint256 id) external view returns (address) {
        return _games[id].winner;
    }
    function getTurn(uint256 id) external view returns (uint8) {
        return _games[id].turn;
    }
    function getHits(uint256 id, uint8 playerIdx) external view returns (uint8) {
        return _games[id].hitsScored[playerIdx];
    }
    function getPlayers(uint256 id) external view returns (address, address) {
        return (_games[id].players[0], _games[id].players[1]);
    }

    /// @notice Returns the encrypted board handle for a player.
    ///         Only the owner (with FHE.allow) can decrypt it; the opponent cannot.
    function getBoard(uint256 id, uint8 playerIdx) external view returns (euint32) {
        return _games[id].boards[playerIdx];
    }

    /// @notice Returns the encrypted popcount handle for the pending board verification.
    function getPendingBoardCount(uint256 id, uint8 playerIdx) external view returns (euint32) {
        return _games[id].pendingBoardCount[playerIdx];
    }

    /// @notice Returns the encrypted hit/miss handle for the pending unresolved shot.
    ///         Both players and the public KMS path can decrypt it.
    function getPendingResult(uint256 id) external view returns (ebool) {
        return _games[id].pendingResult;
    }

    function hasPendingShot(uint256 id) external view returns (bool) {
        return _games[id].hasPending;
    }

    // ── Internal helpers ─────────────────────────────────────────────────────

    /// @dev Homomorphic popcount of the lowest 25 bits of an encrypted uint32.
    ///      Extracts each bit with shr+and, then sums — all on ciphertexts.
    ///      The board layout is never revealed; only the total count is decryptable.
    function _popcount25(euint32 board) internal returns (euint32) {
        euint32 count = FHE.and(board, uint32(1)); // bit 0
        for (uint8 i = 1; i < 25; i++) {
            count = FHE.add(count, FHE.and(FHE.shr(board, i), uint32(1)));
        }
        return count;
    }

    function _playerIdx(Game storage g, address player) internal view returns (uint8) {
        if (g.players[0] == player) return 0;
        if (g.players[1] == player) return 1;
        revert("Not a player");
    }
}

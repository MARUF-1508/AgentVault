// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @title AgentVaultV2
/// @notice On-chain guardrails for AI agents, v2: delegated **session keys** and
/// ERC-20 support on top of the v1 model.
///
/// v1 (`AgentVault`) already caps one agent key. v2 adds the industry-standard
/// primitive for agent wallets: short-lived, tightly-scoped session keys the owner
/// grants and revokes, so a compromised agent key is bounded by both the vault's
/// limits *and* that key's own, smaller, expiring budget.
///
/// Three invariants the tests pin down:
///  - a session's caps are never above the vault's caps at grant time, and the
///    send path re-checks the vault caps anyway, so *lowering a vault cap
///    immediately tightens every existing session*;
///  - a restricted session with an empty target set can pay nobody (fail closed)
///    — "unrestricted" is an explicit, separate choice, never an empty list;
///  - state is written before any external call (checks-effects-interactions),
///    and a reentrancy guard sits in front of every spend.
///
/// `agentSend(address,uint256)` keeps v1's exact signature, so the off-chain
/// executor can route through either vault without changes.
contract AgentVaultV2 {
    address public immutable owner;
    address public agent;
    bool public paused;

    // Vault-level native caps, shared by the root agent and every session.
    uint256 public maxPerTx;
    uint256 public dailyLimit;
    uint256 public spentToday;
    uint64 public dayStart;

    uint256 private _locked;

    /// Vault-level recipient allowlist. Both the root agent and sessions can only
    /// ever pay an address in here.
    mapping(address => bool) public allowedRecipient;

    struct TokenRule {
        bool allowed;
        uint256 dailyLimit;
        uint256 spentToday;
        uint64 dayStart;
    }

    /// token => rule. A token is refused until the owner allows it.
    mapping(address => TokenRule) public tokenRules;

    struct Session {
        bool active;
        uint64 expiry;
        uint256 maxPerTx; // native only
        uint256 dailyLimit; // native only
        uint256 spentToday; // native only
        uint64 dayStart;
        bool canSendNative;
        bool canSendToken;
        /// When true the session may only pay its own `sessionTarget` set (an empty
        /// set means it can pay nobody). When false it may pay any vault-allowed
        /// recipient.
        bool targetsRestricted;
    }

    mapping(address => Session) public sessions;
    /// session => recipient => allowed, only consulted when `targetsRestricted`.
    mapping(address => mapping(address => bool)) public sessionTarget;
    /// session => token => may this session move the token at all.
    mapping(address => mapping(address => bool)) public sessionToken;

    event AgentSpend(address indexed sender, address indexed to, uint256 amount, uint256 spentToday);
    event TokenSpend(address indexed sender, address indexed token, address indexed to, uint256 amount, uint256 spentToday);
    event AgentChanged(address indexed agent);
    event LimitsChanged(uint256 maxPerTx, uint256 dailyLimit);
    event RecipientSet(address indexed to, bool allowed);
    event Paused(bool paused);
    event SessionGranted(address indexed key, uint64 expiry, uint256 maxPerTx, uint256 dailyLimit, bool canSendNative, bool canSendToken, bool targetsRestricted);
    event SessionRevoked(address indexed key);
    event SessionTargetSet(address indexed key, address indexed to, bool allowed);
    event SessionTokenSet(address indexed key, address indexed token, bool allowed);
    event TokenRuleSet(address indexed token, bool allowed, uint256 dailyLimit);

    error NotOwner();
    error NotAgent();
    error IsPaused();
    error RecipientNotAllowed();
    error OverPerTxCap();
    error OverDailyLimit();
    error TransferFailed();
    error ZeroAmount();
    error TokenNotAllowed();
    error SelectorNotAllowed();
    error SessionExpired();
    error SessionCapsAboveVault();
    error SessionOverPerTxCap();
    error SessionOverDailyLimit();
    error BadExpiry();
    error Reentrancy();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// Guards every spend. With checks-effects-interactions this is belt and
    /// braces, but it keeps a hostile token or recipient from re-entering the
    /// accounting paths.
    modifier nonReentrant() {
        if (_locked == 1) revert Reentrancy();
        _locked = 1;
        _;
        _locked = 0;
    }

    constructor(address _agent, uint256 _maxPerTx, uint256 _dailyLimit) payable {
        owner = msg.sender;
        agent = _agent;
        maxPerTx = _maxPerTx;
        dailyLimit = _dailyLimit;
        dayStart = uint64(block.timestamp);
    }

    receive() external payable {}

    // ---- agent-callable entrypoints ----

    /// @notice The only native-spend entrypoint. Same signature as v1, so the
    /// off-chain executor needs no change to route through this vault.
    function agentSend(address payable to, uint256 amount) external nonReentrant {
        if (paused) revert IsPaused();
        if (amount == 0) revert ZeroAmount();

        bool isRoot = _isRootAgent();
        Session storage s = sessions[msg.sender];
        if (!isRoot) {
            if (!s.active) revert NotAgent();
            if (block.timestamp >= s.expiry) revert SessionExpired();
            if (!s.canSendNative) revert SelectorNotAllowed();
        }

        // Vault allowlist always applies; a restricted session narrows it further.
        if (!allowedRecipient[to]) revert RecipientNotAllowed();
        if (!isRoot && s.targetsRestricted && !sessionTarget[msg.sender][to]) revert RecipientNotAllowed();

        if (block.timestamp >= dayStart + 1 days) {
            dayStart = uint64(block.timestamp);
            spentToday = 0;
        }
        if (!isRoot && block.timestamp >= s.dayStart + 1 days) {
            s.dayStart = uint64(block.timestamp);
            s.spentToday = 0;
        }

        if (amount > maxPerTx) revert OverPerTxCap();
        if (spentToday + amount > dailyLimit) revert OverDailyLimit();
        if (!isRoot) {
            if (amount > s.maxPerTx) revert SessionOverPerTxCap();
            if (s.spentToday + amount > s.dailyLimit) revert SessionOverDailyLimit();
            s.spentToday += amount;
        }
        spentToday += amount;

        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit AgentSpend(msg.sender, to, amount, spentToday);
    }

    /// @notice ERC-20 spend. Needs an allowlisted token, the session's token
    /// grant (selector binding: a native-only session cannot call this) and the
    /// same recipient rules as `agentSend`.
    function agentSendToken(address token, address to, uint256 amount) external nonReentrant {
        if (paused) revert IsPaused();
        if (amount == 0) revert ZeroAmount();
        TokenRule storage r = tokenRules[token];
        if (!r.allowed) revert TokenNotAllowed();

        bool isRoot = _isRootAgent();
        Session storage s = sessions[msg.sender];
        if (!isRoot) {
            if (!s.active) revert NotAgent();
            if (block.timestamp >= s.expiry) revert SessionExpired();
            if (!s.canSendToken) revert SelectorNotAllowed();
            if (!sessionToken[msg.sender][token]) revert TokenNotAllowed();
        }

        if (!allowedRecipient[to]) revert RecipientNotAllowed();
        if (!isRoot && s.targetsRestricted && !sessionTarget[msg.sender][to]) revert RecipientNotAllowed();

        if (block.timestamp >= r.dayStart + 1 days) {
            r.dayStart = uint64(block.timestamp);
            r.spentToday = 0;
        }
        if (r.spentToday + amount > r.dailyLimit) revert OverDailyLimit();
        r.spentToday += amount;

        if (!IERC20(token).transfer(to, amount)) revert TransferFailed();
        emit TokenSpend(msg.sender, token, to, amount, r.spentToday);
    }

    // ---- session-key controls (owner only) ----

    /// @notice Grants (or replaces) a session key. Caps must not exceed the
    /// vault's, and the expiry must be in the future.
    function grantSessionKey(
        address key,
        uint64 expiry,
        uint256 sessionMaxPerTx,
        uint256 sessionDailyLimit,
        bool canSendNative,
        bool canSendToken,
        bool targetsRestricted
    ) external onlyOwner {
        if (key == address(0)) revert NotAgent();
        if (expiry <= block.timestamp) revert BadExpiry();
        if (!canSendNative && !canSendToken) revert SelectorNotAllowed();
        if (sessionMaxPerTx > maxPerTx || sessionDailyLimit > dailyLimit) revert SessionCapsAboveVault();

        Session storage s = sessions[key];
        s.active = true;
        s.expiry = expiry;
        s.maxPerTx = sessionMaxPerTx;
        s.dailyLimit = sessionDailyLimit;
        s.spentToday = 0;
        s.dayStart = uint64(block.timestamp);
        s.canSendNative = canSendNative;
        s.canSendToken = canSendToken;
        s.targetsRestricted = targetsRestricted;

        emit SessionGranted(key, expiry, sessionMaxPerTx, sessionDailyLimit, canSendNative, canSendToken, targetsRestricted);
    }

    function revokeSessionKey(address key) external onlyOwner {
        delete sessions[key];
        emit SessionRevoked(key);
    }

    /** Adds or removes one recipient for a restricted session. */
    function setSessionTarget(address key, address to, bool allowed) external onlyOwner {
        sessionTarget[key][to] = allowed;
        emit SessionTargetSet(key, to, allowed);
    }

    /** Adds or removes one token a session may move. */
    function setSessionToken(address key, address token, bool allowed) external onlyOwner {
        sessionToken[key][token] = allowed;
        emit SessionTokenSet(key, token, allowed);
    }

    // ---- vault controls (owner only) ----

    function setAllowedToken(address token, bool allowed, uint256 tokenDailyLimit) external onlyOwner {
        TokenRule storage r = tokenRules[token];
        r.allowed = allowed;
        r.dailyLimit = tokenDailyLimit;
        if (block.timestamp >= r.dayStart + 1 days) {
            r.dayStart = uint64(block.timestamp);
            r.spentToday = 0;
        }
        emit TokenRuleSet(token, allowed, tokenDailyLimit);
    }

    function setPaused(bool p) external onlyOwner {
        paused = p;
        emit Paused(p);
    }

    function setAgent(address a) external onlyOwner {
        agent = a;
        emit AgentChanged(a);
    }

    function setLimits(uint256 _maxPerTx, uint256 _dailyLimit) external onlyOwner {
        maxPerTx = _maxPerTx;
        dailyLimit = _dailyLimit;
        emit LimitsChanged(_maxPerTx, _dailyLimit);
    }

    function setRecipient(address to, bool allowed) external onlyOwner {
        allowedRecipient[to] = allowed;
        emit RecipientSet(to, allowed);
    }

    function withdraw(uint256 amount) external onlyOwner {
        (bool ok, ) = payable(owner).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    function withdrawToken(address token, uint256 amount) external onlyOwner {
        if (!IERC20(token).transfer(owner, amount)) revert TransferFailed();
    }

    // ---- internals ----

    function _isRootAgent() private view returns (bool) {
        return agent != address(0) && msg.sender == agent;
    }
}

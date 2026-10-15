// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title AgentVault
/// @notice On-chain guardrails for an AI agent's hot key (challenge-bonus stretch goal).
/// The owner (a human, ideally a hardware wallet) funds the vault. The agent key can only
/// send ETH to allowlisted recipients, within a per-tx cap and a rolling daily limit.
/// Even if the agent key or the LLM is fully compromised, the worst case is one day's limit.
contract AgentVault {
    address public immutable owner;
    address public agent;
    bool public paused;

    uint256 public maxPerTx;
    uint256 public dailyLimit;
    uint256 public spentToday;
    uint256 public dayStart;

    mapping(address => bool) public allowedRecipient;

    event AgentSpend(address indexed to, uint256 amount, uint256 spentToday);
    event AgentChanged(address indexed agent);
    event LimitsChanged(uint256 maxPerTx, uint256 dailyLimit);
    event RecipientSet(address indexed to, bool allowed);
    event Paused(bool paused);

    error NotOwner();
    error NotAgent();
    error IsPaused();
    error RecipientNotAllowed();
    error OverPerTxCap();
    error OverDailyLimit();
    error TransferFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address _agent, uint256 _maxPerTx, uint256 _dailyLimit) payable {
        owner = msg.sender;
        agent = _agent;
        maxPerTx = _maxPerTx;
        dailyLimit = _dailyLimit;
        dayStart = block.timestamp;
    }

    receive() external payable {}

    /// @notice The only function the agent key can call.
    function agentSend(address payable to, uint256 amount) external {
        if (msg.sender != agent) revert NotAgent();
        if (paused) revert IsPaused();
        if (!allowedRecipient[to]) revert RecipientNotAllowed();
        if (amount > maxPerTx) revert OverPerTxCap();

        if (block.timestamp >= dayStart + 1 days) {
            dayStart = block.timestamp;
            spentToday = 0;
        }
        if (spentToday + amount > dailyLimit) revert OverDailyLimit();
        spentToday += amount;

        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit AgentSpend(to, amount, spentToday);
    }

    // ---- owner controls ----

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
}

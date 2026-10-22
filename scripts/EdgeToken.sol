// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract SilentToken {
    string public name = "Silent";
    string public symbol = "ST";
    uint8 public decimals = 18;
    mapping(address => uint256) public balanceOf;

    event Transfer(address indexed from, address indexed to, uint256 value);

    constructor(uint256 supply) {
        balanceOf[msg.sender] = supply;
        emit Transfer(address(0), msg.sender, supply);
    }

    function transfer(address to, uint256 amount) external {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
    }
}

contract LieToken {
    string public name = "Lie";
    string public symbol = "LT";
    uint8 public decimals = 18;
    mapping(address => uint256) public balanceOf;

    constructor(uint256 supply) {
        balanceOf[msg.sender] = supply;
    }

    function transfer(address, uint256) external pure returns (bool) {
        return true;
    }
}

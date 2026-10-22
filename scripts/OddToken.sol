// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract FalseToken {
    string public name = "False";
    string public symbol = "FT";
    uint8 public decimals = 18;
    mapping(address => uint256) public balanceOf;

    event Transfer(address indexed from, address indexed to, uint256 value);

    constructor(uint256 supply) {
        balanceOf[msg.sender] = supply;
        emit Transfer(address(0), msg.sender, supply);
    }

    function transfer(address, uint256) external pure returns (bool) {
        return false;
    }
}

contract RevertToken {
    string public name = "Revert";
    string public symbol = "RT";
    uint8 public decimals = 18;
    mapping(address => uint256) public balanceOf;

    constructor(uint256 supply) {
        balanceOf[msg.sender] = supply;
    }

    function transfer(address, uint256) external pure returns (bool) {
        revert("no");
    }
}

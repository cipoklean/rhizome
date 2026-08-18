// Test doubles for exercising the anonymizer.
//
// Not part of the production surface. A minimal ERC-20 and a 1:1 Vesu-style
// vault, enough to drive `privacy_invoke` through both directions and its
// failure cases without touching mainnet.

use starknet::ContractAddress;

#[starknet::interface]
pub trait IMockERC20<TContractState> {
    fn mint(ref self: TContractState, recipient: ContractAddress, amount: u256);
    fn total_supply(self: @TContractState) -> u256;
    fn balance_of(self: @TContractState, account: ContractAddress) -> u256;
    fn allowance(self: @TContractState, owner: ContractAddress, spender: ContractAddress) -> u256;
    fn transfer(ref self: TContractState, recipient: ContractAddress, amount: u256) -> bool;
    fn transfer_from(
        ref self: TContractState,
        sender: ContractAddress,
        recipient: ContractAddress,
        amount: u256,
    ) -> bool;
    fn approve(ref self: TContractState, spender: ContractAddress, amount: u256) -> bool;
}

#[starknet::contract]
pub mod MockERC20 {
    use starknet::storage::{
        Map, StorageMapReadAccess, StorageMapWriteAccess, StoragePointerReadAccess,
        StoragePointerWriteAccess,
    };
    use starknet::{ContractAddress, get_caller_address};
    use super::IMockERC20;

    #[storage]
    struct Storage {
        supply: u256,
        balances: Map<ContractAddress, u256>,
        allowances: Map<(ContractAddress, ContractAddress), u256>,
    }

    #[abi(embed_v0)]
    pub impl MockERC20Impl of IMockERC20<ContractState> {
        fn mint(ref self: ContractState, recipient: ContractAddress, amount: u256) {
            self.balances.write(recipient, self.balances.read(recipient) + amount);
            self.supply.write(self.supply.read() + amount);
        }

        fn total_supply(self: @ContractState) -> u256 {
            self.supply.read()
        }

        fn balance_of(self: @ContractState, account: ContractAddress) -> u256 {
            self.balances.read(account)
        }

        fn allowance(
            self: @ContractState, owner: ContractAddress, spender: ContractAddress,
        ) -> u256 {
            self.allowances.read((owner, spender))
        }

        fn transfer(ref self: ContractState, recipient: ContractAddress, amount: u256) -> bool {
            let caller = get_caller_address();
            let from_balance = self.balances.read(caller);
            assert(from_balance >= amount, 'MOCK_INSUFFICIENT_BALANCE');
            self.balances.write(caller, from_balance - amount);
            self.balances.write(recipient, self.balances.read(recipient) + amount);
            true
        }

        fn transfer_from(
            ref self: ContractState,
            sender: ContractAddress,
            recipient: ContractAddress,
            amount: u256,
        ) -> bool {
            let caller = get_caller_address();
            let allowed = self.allowances.read((sender, caller));
            assert(allowed >= amount, 'MOCK_INSUFFICIENT_ALLOWANCE');
            let from_balance = self.balances.read(sender);
            assert(from_balance >= amount, 'MOCK_INSUFFICIENT_BALANCE');
            self.allowances.write((sender, caller), allowed - amount);
            self.balances.write(sender, from_balance - amount);
            self.balances.write(recipient, self.balances.read(recipient) + amount);
            true
        }

        fn approve(ref self: ContractState, spender: ContractAddress, amount: u256) -> bool {
            let caller = get_caller_address();
            self.allowances.write((caller, spender), amount);
            true
        }
    }
}

#[starknet::interface]
pub trait IMockVault<TContractState> {
    // Share-token ERC-20 surface.
    fn total_supply(self: @TContractState) -> u256;
    fn balance_of(self: @TContractState, account: ContractAddress) -> u256;
    fn allowance(self: @TContractState, owner: ContractAddress, spender: ContractAddress) -> u256;
    fn transfer(ref self: TContractState, recipient: ContractAddress, amount: u256) -> bool;
    fn transfer_from(
        ref self: TContractState,
        sender: ContractAddress,
        recipient: ContractAddress,
        amount: u256,
    ) -> bool;
    fn approve(ref self: TContractState, spender: ContractAddress, amount: u256) -> bool;
    // Vault surface.
    fn deposit(ref self: TContractState, assets: u256, receiver: ContractAddress) -> u256;
    fn withdraw(
        ref self: TContractState, assets: u256, receiver: ContractAddress, owner: ContractAddress,
    ) -> u256;
    // Test helper: hand out shares without a deposit.
    fn mint_shares(ref self: TContractState, recipient: ContractAddress, amount: u256);
}

/// A 1:1 vault. `mints_shares = false` produces a vault that swallows the
/// deposit without minting, which is how we test the zero-output guard.
#[starknet::contract]
pub mod MockVesuVault {
    use openzeppelin::interfaces::token::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
    use starknet::storage::{
        Map, StorageMapReadAccess, StorageMapWriteAccess, StoragePointerReadAccess,
        StoragePointerWriteAccess,
    };
    use starknet::{ContractAddress, get_caller_address, get_contract_address};
    use super::IMockVault;

    #[storage]
    struct Storage {
        underlying: ContractAddress,
        mints_shares: bool,
        supply: u256,
        shares: Map<ContractAddress, u256>,
        allowances: Map<(ContractAddress, ContractAddress), u256>,
    }

    #[constructor]
    fn constructor(
        ref self: ContractState, underlying: ContractAddress, mints_shares: bool,
    ) {
        self.underlying.write(underlying);
        self.mints_shares.write(mints_shares);
    }

    #[abi(embed_v0)]
    pub impl MockVaultImpl of IMockVault<ContractState> {
        fn total_supply(self: @ContractState) -> u256 {
            self.supply.read()
        }

        fn balance_of(self: @ContractState, account: ContractAddress) -> u256 {
            self.shares.read(account)
        }

        fn allowance(
            self: @ContractState, owner: ContractAddress, spender: ContractAddress,
        ) -> u256 {
            self.allowances.read((owner, spender))
        }

        fn transfer(ref self: ContractState, recipient: ContractAddress, amount: u256) -> bool {
            let caller = get_caller_address();
            let from_balance = self.shares.read(caller);
            assert(from_balance >= amount, 'MOCK_INSUFFICIENT_SHARES');
            self.shares.write(caller, from_balance - amount);
            self.shares.write(recipient, self.shares.read(recipient) + amount);
            true
        }

        fn transfer_from(
            ref self: ContractState,
            sender: ContractAddress,
            recipient: ContractAddress,
            amount: u256,
        ) -> bool {
            let caller = get_caller_address();
            let allowed = self.allowances.read((sender, caller));
            assert(allowed >= amount, 'MOCK_INSUFFICIENT_ALLOWANCE');
            let from_balance = self.shares.read(sender);
            assert(from_balance >= amount, 'MOCK_INSUFFICIENT_SHARES');
            self.allowances.write((sender, caller), allowed - amount);
            self.shares.write(sender, from_balance - amount);
            self.shares.write(recipient, self.shares.read(recipient) + amount);
            true
        }

        fn approve(ref self: ContractState, spender: ContractAddress, amount: u256) -> bool {
            let caller = get_caller_address();
            self.allowances.write((caller, spender), amount);
            true
        }

        fn deposit(ref self: ContractState, assets: u256, receiver: ContractAddress) -> u256 {
            let caller = get_caller_address();
            IERC20Dispatcher { contract_address: self.underlying.read() }
                .transfer_from(caller, get_contract_address(), assets);

            if self.mints_shares.read() {
                self.shares.write(receiver, self.shares.read(receiver) + assets);
                self.supply.write(self.supply.read() + assets);
                assets
            } else {
                0
            }
        }

        fn withdraw(
            ref self: ContractState,
            assets: u256,
            receiver: ContractAddress,
            owner: ContractAddress,
        ) -> u256 {
            let owner_shares = self.shares.read(owner);
            assert(owner_shares >= assets, 'MOCK_INSUFFICIENT_SHARES');
            self.shares.write(owner, owner_shares - assets);
            self.supply.write(self.supply.read() - assets);

            IERC20Dispatcher { contract_address: self.underlying.read() }
                .transfer(receiver, assets);
            assets
        }

        fn mint_shares(ref self: ContractState, recipient: ContractAddress, amount: u256) {
            self.shares.write(recipient, self.shares.read(recipient) + amount);
            self.supply.write(self.supply.read() + amount);
        }
    }
}

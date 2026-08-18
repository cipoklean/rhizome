// Rhizome — Vesu lending anonymizer
//
// A `privacy_invoke` helper contract. The STRK20 pool withdraws tokens to this
// contract, calls `privacy_invoke`, and this contract returns instructions for
// which open notes the pool should credit with what it produced.
//
// Adapted from StarkWare's reference `vesu_lending_anonymizer`
// (github.com/starkware-libs/starknet-privacy, Apache-2.0).
//
// UNAUDITED. Funds are held only transiently, inside a single atomic pool
// transaction: if any step reverts, nothing moves.

use privacy::objects::OpenNoteDeposit;
use starknet::ContractAddress;

/// A Vesu vToken vault (ERC-4626 / SNIP-22 compatible).
#[starknet::interface]
pub trait IVToken<TContractState> {
    /// Deposits assets and mints vToken shares to `receiver`.
    fn deposit(ref self: TContractState, assets: u256, receiver: ContractAddress) -> u256;
    /// Burns shares from `owner` and sends underlying assets to `receiver`.
    fn withdraw(
        ref self: TContractState, assets: u256, receiver: ContractAddress, owner: ContractAddress,
    ) -> u256;
}

/// Which side of the lending position to move.
#[derive(Serde, Copy, Drop, PartialEq, Debug)]
pub enum LendingOperation {
    /// Underlying -> vToken shares. `out_token` is the vault.
    Deposit,
    /// vToken shares -> underlying. `in_token` is the vault.
    Withdraw,
}

#[starknet::interface]
pub trait IRhizomeVesuAnonymizer<TContractState> {
    /// The entry point the privacy pool calls via `INVOKE_SELECTOR`.
    ///
    /// Calldata after the selector is deserialized into these parameters, and the
    /// return value tells the pool which open notes to credit.
    fn privacy_invoke(
        ref self: TContractState,
        operation: LendingOperation,
        in_token: ContractAddress,
        out_token: ContractAddress,
        assets: u256,
        note_id: felt252,
    ) -> Span<OpenNoteDeposit>;
}

pub mod errors {
    pub const ZERO_IN_TOKEN: felt252 = 'ZERO_IN_TOKEN';
    pub const ZERO_OUT_TOKEN: felt252 = 'ZERO_OUT_TOKEN';
    pub const ZERO_ASSETS: felt252 = 'ZERO_ASSETS';
    pub const TOKENS_EQUAL: felt252 = 'TOKENS_EQUAL';
    pub const INSUFFICIENT_BALANCE: felt252 = 'INSUFFICIENT_BALANCE';
    pub const RECEIVED_AMOUNT_OVERFLOW: felt252 = 'RECEIVED_AMOUNT_OVERFLOW';
    pub const ZERO_OUT_AMOUNT: felt252 = 'ZERO_OUT_AMOUNT';
}

#[starknet::contract]
pub mod RhizomeVesuAnonymizer {
    use core::num::traits::Zero;
    use openzeppelin::interfaces::token::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
    use privacy::objects::OpenNoteDeposit;
    use starknet::{ContractAddress, get_caller_address, get_contract_address};
    use super::{
        IRhizomeVesuAnonymizer, IVTokenDispatcher, IVTokenDispatcherTrait, LendingOperation, errors,
    };

    #[storage]
    struct Storage {}

    #[constructor]
    fn constructor(ref self: ContractState) {}

    #[abi(embed_v0)]
    pub impl RhizomeVesuAnonymizerImpl of IRhizomeVesuAnonymizer<ContractState> {
        fn privacy_invoke(
            ref self: ContractState,
            operation: LendingOperation,
            in_token: ContractAddress,
            out_token: ContractAddress,
            assets: u256,
            note_id: felt252,
        ) -> Span<OpenNoteDeposit> {
            assert(in_token.is_non_zero(), errors::ZERO_IN_TOKEN);
            assert(out_token.is_non_zero(), errors::ZERO_OUT_TOKEN);
            assert(assets.is_non_zero(), errors::ZERO_ASSETS);
            assert(in_token != out_token, errors::TOKENS_EQUAL);

            let self_addr = get_contract_address();
            // The pool is the caller; it is the only party that should be able to
            // pull our output, and it does so within this same transaction.
            let pool_addr = get_caller_address();

            let in_erc20 = IERC20Dispatcher { contract_address: in_token };
            let out_erc20 = IERC20Dispatcher { contract_address: out_token };

            // The pool has already transferred `assets` of `in_token` to us.
            assert(in_erc20.balance_of(self_addr) >= assets, errors::INSUFFICIENT_BALANCE);

            // Snapshot the output balance before touching Vesu, so we can measure
            // exactly what arrived rather than trusting a return value.
            let balance_before = out_erc20.balance_of(self_addr);

            match operation {
                LendingOperation::Deposit => {
                    // The vault is the output token; approve it to pull the underlying.
                    in_erc20.approve(out_token, assets);
                    IVTokenDispatcher { contract_address: out_token }
                        .deposit(assets, self_addr)
                },
                LendingOperation::Withdraw => {
                    // The vault is the input token; burn our shares for underlying.
                    IVTokenDispatcher { contract_address: in_token }
                        .withdraw(assets, self_addr, self_addr)
                },
            };

            // Balance-delta idiom: credit exactly what landed, whatever Vesu did.
            let balance_after = out_erc20.balance_of(self_addr);
            let out_amount: u128 = (balance_after - balance_before)
                .try_into()
                .expect(errors::RECEIVED_AMOUNT_OVERFLOW);
            assert(out_amount.is_non_zero(), errors::ZERO_OUT_AMOUNT);

            // Approve, don't transfer — the pool pulls the output itself.
            out_erc20.approve(pool_addr, out_amount.into());

            [OpenNoteDeposit { note_id, token: out_token, amount: out_amount }].span()
        }
    }
}

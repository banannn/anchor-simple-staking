use anchor_lang::prelude::*;
use anchor_spl::token::{self, TokenAccount, SetAuthority, Transfer};
use spl_token::instruction::AuthorityType;

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

// assumption every user can join just once and withdraw everything
// pro rata counted on deposited tokens
// rewards after 5 stakers joined
// when staker leaves after cap of 5 users reached - no new staker can joined
// no support for withdraw before cap reached

#[program]
pub mod simple_staking {
    use super::*;

    pub fn initialize(ctx: Context<InitializePool>) -> ProgramResult {

        // Transfer vault authority to PDA
        let (pda, seed) = Pubkey::find_program_address(&[ctx.accounts.pool.to_account_info().key.as_ref()], ctx.program_id);
        let cpi_accounts = SetAuthority{
            current_authority: ctx.accounts.authority.clone(),
            account_or_mint: ctx.accounts.vault.to_account_info().clone()
        };
        let cpi_program = ctx.accounts.token_program.clone();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        token::set_authority(cpi_ctx, AuthorityType::AccountOwner, Some(pda))?;

        // Save pool
        let pool = &mut ctx.accounts.pool;
        pool.mint = *ctx.accounts.mint.key;
        pool.vault = *ctx.accounts.vault.to_account_info().key;
        pool.seed = seed;
        pool.stakers_count = 0;
        pool.total_staked = 0;
        pool.total_shares = 0;
        
        Ok(())
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> ProgramResult {
        
        let pool = &mut ctx.accounts.pool;

        if amount == 0 {
            return Err(ErrorCode::DepositTooLow.into());
        }

        // cap of 5 stakers
        if pool.stakers_count >= 5 {
            return Err(ErrorCode::StakersMaxCap.into());
        }

        pool.stakers_count += 1;

        // Transfer tokens to vault
        let cpi_program = ctx.accounts.token_program.clone();
        let cpi_accounts = Transfer{
            from: ctx.accounts.from.to_account_info().clone(),
            to: ctx.accounts.vault.clone(),
            authority: ctx.accounts.owner.clone()
        };
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        let _transfer_result = token::transfer(cpi_ctx, amount);  // TODO what to do with result

        // create staker account and distribute shares
        let staker = &mut ctx.accounts.staker_details;
        staker.owner = *ctx.accounts.owner.key;
        staker.deposited = amount;
        staker.withdrawn = false;

        if pool.stakers_count == 1 {
            staker.shares = 10000;
        }
        else {
            let new_shares = pool.total_shares * amount / pool.total_staked;
            staker.shares = new_shares;
        }

        pool.total_shares += staker.shares;
        pool.total_staked += amount;

        Ok(())
    }

    pub fn withdraw(ctx: Context<Withdraw>) -> ProgramResult {
        let staker = &mut ctx.accounts.staker_details;
        if staker.withdrawn {
            return Err(ErrorCode::TooGreedy.into())
        }
        let pool = &mut ctx.accounts.pool;
        let vault = &mut ctx.accounts.vault;
        let withdraw_amount = vault.amount * staker.shares / pool.total_shares;
        
        // Transfer tokens back to user
        let cpi_program = ctx.accounts.token_program.clone();
        let cpi_accounts = Transfer{
            from: ctx.accounts.vault.to_account_info().clone(),
            to: ctx.accounts.to.to_account_info().clone(),
            authority: ctx.accounts.vault_authority.clone()
        };
        let seeds = &[
            pool.to_account_info().key.as_ref(),
            &[pool.seed],
        ];
        let signer =  &[&seeds[..]];
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts,  signer);
        let _transfer_result = token::transfer(cpi_ctx, withdraw_amount);  

        // update pool and staker
        pool.total_shares -= staker.shares;
        staker.withdrawn = true;
        staker.shares = 0;

        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializePool<'info>  {
    // pool info
    #[account(init, payer = authority, space = 8 + 96 + 128)]
    pub pool: Account<'info, StakingPool>,
    #[account(signer)]
    pub authority: AccountInfo<'info>,
    #[account(mut, constraint = &vault.owner == authority.key)]
    pub vault: Account<'info, TokenAccount>,
    pub system_program: Program<'info, System>, // to create pool account
    pub token_program: AccountInfo<'info>, // to transfer authority
    pub mint: AccountInfo<'info>, // token for pool
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    
    #[account(mut)]
    pub pool : Account<'info, StakingPool>,
    #[account(mut, constraint = vault.key == &pool.vault)]
    vault: AccountInfo<'info>,
    #[account(signer)]
    pub owner: AccountInfo<'info>,
    #[account(init, payer = owner, space = 8 + 40 + 128 + 1)]
    // #[account(mut)]
    pub staker_details: Account<'info, StakerDetails>,
    #[account(mut, constraint = &from.owner == owner.key)]
    pub from: Account<'info, TokenAccount>,
    pub token_program: AccountInfo<'info>, // to transfer tokens
    pub system_program: Program<'info, System>, // to create staker_info account
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub pool : Account<'info, StakingPool>,
    #[account(mut, has_one = owner)]
    pub staker_details: Account<'info, StakerDetails>,
    #[account(mut, constraint = vault.to_account_info().key == &pool.vault)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut)]
    to: Account<'info, TokenAccount>,
    #[account(signer)]
    owner: AccountInfo<'info>,
    vault_authority: AccountInfo<'info>,
    pub token_program: AccountInfo<'info>, // to transfer tokens
}

#[account]
pub struct StakingPool {
    pub mint: Pubkey,
    pub vault: Pubkey,
    pub seed: u8,
    pub stakers_count: u8,
    pub total_staked: u64,
    pub total_shares: u64,
}

#[account]
pub struct StakerDetails {
    pub owner: Pubkey,
    pub deposited: u64,
    pub shares: u64,
    pub withdrawn: bool
}

#[error]
pub enum ErrorCode {
    #[msg("Stakers cap reached")]
    StakersMaxCap,
    #[msg("Deposit too low")]
    DepositTooLow,
    #[msg("AlreadyWithdrawn")]
    TooGreedy,
}

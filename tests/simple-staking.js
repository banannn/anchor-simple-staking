const anchor = require('@project-serum/anchor');
const { NodeWallet } = require('@project-serum/anchor/dist/cjs/provider');
const serumCmn = require("@project-serum/common");
const { TOKEN_PROGRAM_ID, Token } = require("@solana/spl-token");
const { SystemProgram } = anchor.web3;
const assert = require('assert');
const expect = require( 'chai')


describe('simple-staking', () => {

  // Configure the client to use the local cluster.
  const provider = anchor.Provider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.SimpleStaking;

  let tokenMint = null;
  let mintAuthority = anchor.web3.Keypair.generate();
  let stakers = [], stakersTokenAccounts = [], stakerDetails = []
  for (let i=0; i<6; i++) {
    stakers.push(anchor.web3.Keypair.generate())
    stakerDetails.push(anchor.web3.Keypair.generate())
  }

  const pool = anchor.web3.Keypair.generate();
  let vault;

  it('Setup initial state', async () => {
    
    // create mint and mint some tokens
    tokenMint = await Token.createMint(provider.connection, provider.wallet.payer, mintAuthority.publicKey, null, 0, TOKEN_PROGRAM_ID);
    for (let i=0; i<6; i++) {
      stakersTokenAccounts[i] = await tokenMint.createAssociatedTokenAccount(stakers[i].publicKey)    // exact diffference between createAccount?
      await tokenMint.mintTo(stakersTokenAccounts[i], mintAuthority.publicKey, [mintAuthority], 100);
      await provider.connection.confirmTransaction(
        await provider.connection.requestAirdrop(stakers[i].publicKey, 10000000000),
        "confirmed"
      );
    }
    vault = await tokenMint.createAccount(provider.wallet.publicKey)
    await printBalances();
  });
  
  it('Fail when initialize with wrong vault owner', async () => {
    let errMsg = ''
      try {
          await program.rpc.initialize(
            {
              accounts: {
                pool: pool.publicKey,
                authority: provider.wallet.publicKey,
                vault: stakersTokenAccounts[0],
                systemProgram: SystemProgram.programId,
                mint: tokenMint.publicKey,
                tokenProgram: TOKEN_PROGRAM_ID,
              },
              signers: [pool]
            }
          )
          assert.ok(false);
       } catch(err) {
          errMsg = err.toString();
      }
      assert.ok(errMsg.includes("A raw constraint was violated"))
    }
  );

  it('Initialize pool', async () => {
    await program.rpc.initialize(
      {
        accounts: {
          pool: pool.publicKey,
          authority: provider.wallet.publicKey,
          vault: vault,
          systemProgram: SystemProgram.programId,
          mint: tokenMint.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        signers: [pool]
      }
    );

    let poolAccount = await program.account.stakingPool.fetch(pool.publicKey)
    assert.ok(poolAccount.mint.equals(tokenMint.publicKey))
    assert.ok(poolAccount.vault.equals(vault))
    assert.ok(poolAccount.stakersCount == 0)
    assert.ok(poolAccount.totalStaked == 0)
    assert.ok(poolAccount.totalShares == 0)
    let [pda, _nonce] = await anchor.web3.PublicKey.findProgramAddress(
        [pool.publicKey.toBuffer()],
        program.programId
      )
    let vaultAccount = await serumCmn.getTokenAccount(provider, vault)
    assert.ok(vaultAccount.owner.equals(pda))
  });
  
  it('Deposit tokens', async () => {
    for (let i=0; i<5; i++) {
      // TODO how to do it better?, why signers[] is not sufficient
      provider.wallet = new NodeWallet(stakers[i ])
      program.provider = provider
      
      await program.rpc.deposit(
        new anchor.BN((i+1)*10),
        {
          accounts: {
            pool: pool.publicKey,
            vault: vault,
            owner: stakers[i].publicKey,
            from: stakersTokenAccounts[i],
            stakerDetails: stakerDetails[i].publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          },
          signers: [stakerDetails[i]]
        }
      )
      let stakerDetailsAccount = await program.account.stakerDetails.fetch(stakerDetails[i].publicKey)
      assert.ok(stakerDetailsAccount.owner.equals(stakers[i].publicKey))
      assert.ok(stakerDetailsAccount.deposited == (i+1)*10)
      
    }
    await printBalances();
  });
  
  it('6th staker should fail', async () => {
      provider.wallet = new NodeWallet(stakers[5])
      program.provider = provider
      let errMsg = ''
      try {
        await program.rpc.deposit(
          new anchor.BN(50),
          {
            accounts: {
              pool: pool.publicKey,
              vault: vault,
              owner: stakers[5].publicKey,
              from: stakersTokenAccounts[5],
              stakerDetails: stakerDetails[5].publicKey,
              tokenProgram: TOKEN_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
            },
            signers: [stakers[5], stakerDetails[5]]
          }
        )
        assert.ok(false);
      } catch(err) {
          errMsg = err.toString();
      }
      assert.ok(errMsg.includes("Stakers cap reached"))
    })

  it('Mint some tokens to vault', async () => {
    await tokenMint.mintTo(vault, mintAuthority.publicKey, [mintAuthority], 150);
    let vaultAccount = await serumCmn.getTokenAccount(provider, vault)
    assert.ok(vaultAccount.amount == 300)
  })

  it('Third party cant withdraw', async () => {
    provider.wallet = new NodeWallet(stakers[5])
    program.provider = provider
    let [pda, _nonce] = await anchor.web3.PublicKey.findProgramAddress(
      [pool.publicKey.toBuffer()],
      program.programId
    )
    let errMsg = ''
    try {
      await program.rpc.withdraw(
        {
          accounts: {
            pool: pool.publicKey,
            stakerDetails: stakerDetails[0].publicKey,
            vault: vault,
            vaultAuthority: pda,
            owner: stakers[5].publicKey,
            to: stakersTokenAccounts[5],
            tokenProgram: TOKEN_PROGRAM_ID,
          },
        }
      )
      assert.ok(false)
    } catch(err) {
      errMsg = err.toString()
    }
    assert.ok(errMsg.includes('A has_one constraint was violated'))

  })
  
  it('Withdraw tokens', async () => {
    let [pda, _nonce] = await anchor.web3.PublicKey.findProgramAddress(
      [pool.publicKey.toBuffer()],
      program.programId
    )

    for (let i=4; i>=0; i--) {
      provider.wallet = new NodeWallet(stakers[i])
      program.provider = provider
      
      await program.rpc.withdraw(
        {
          accounts: {
            pool: pool.publicKey,
            stakerDetails: stakerDetails[i].publicKey,
            vault: vault,
            vaultAuthority: pda,
            owner: stakers[i].publicKey,
            to: stakersTokenAccounts[i],
            tokenProgram: TOKEN_PROGRAM_ID,
          },
        }
      )
      assert.ok( (await serumCmn.getTokenAccount(provider, stakersTokenAccounts[i])).amount == 100 + (i+1)*10)
    }
    assert.ok( (await serumCmn.getTokenAccount(provider, vault)).amount == 0)
    await printBalances();
  });


  // utils
  const printBalances = async () => {
    console.log("Total supply: " + (await tokenMint.getMintInfo()).supply)
    for (let i=0; i<6; i++) {
      console.log("ACC #" + i + ": " + (await serumCmn.getTokenAccount(provider, stakersTokenAccounts[i])).amount)
    }
    let vaultAccount = await serumCmn.getTokenAccount(provider, vault)
    console.log("VAULT: " + vaultAccount.amount + " owner:" + vaultAccount.owner)
  }

  
});



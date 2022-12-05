import { Decimal } from 'decimal.js'
import { BigNumber, BigNumberish, ContractTransaction, Wallet } from 'ethers'
import { ethers, waffle } from 'hardhat'
import { MockTimeUniswapV3Pool } from '../typechain/MockTimeUniswapV3Pool'
import { TestERC20 } from '../typechain/TestERC20'
import { Pool } from '@uniswap/v3-sdk';
import { TestUniswapV3Callee } from '../typechain/TestUniswapV3Callee'
import { expect } from './shared/expect'
import { poolFixture } from './shared/fixtures'
import { Token, CurrencyAmount } from '@uniswap/sdk-core';
import JSBI from 'jsbi';
import { formatPrice, formatTokenAmount } from './shared/format'
import {
  createPoolFunctions,
  encodePriceSqrt,
  expandTo18Decimals,
  FeeAmount,
  getMaxLiquidityPerTick,
  getMaxTick,
  getMinTick,
  MAX_SQRT_RATIO,
  MaxUint128,
  MIN_SQRT_RATIO,
  TICK_SPACINGS,
} from './shared/utilities'

Decimal.config({ toExpNeg: -500, toExpPos: 500 })

const createFixtureLoader = waffle.createFixtureLoader
const { constants } = ethers

interface BaseSwapTestCase {
  zeroForOne: boolean
  sqrtPriceLimit?: BigNumber
}
interface SwapExact0For1TestCase extends BaseSwapTestCase {
  zeroForOne: true
  exactOut: false
  amount0: BigNumberish
  sqrtPriceLimit?: BigNumber
}
interface SwapExact1For0TestCase extends BaseSwapTestCase {
  zeroForOne: false
  exactOut: false
  amount1: BigNumberish
  sqrtPriceLimit?: BigNumber
}
interface Swap0ForExact1TestCase extends BaseSwapTestCase {
  zeroForOne: true
  exactOut: true
  amount1: BigNumberish
  sqrtPriceLimit?: BigNumber
}
interface Swap1ForExact0TestCase extends BaseSwapTestCase {
  zeroForOne: false
  exactOut: true
  amount0: BigNumberish
  sqrtPriceLimit?: BigNumber
}
interface SwapToHigherPrice extends BaseSwapTestCase {
  zeroForOne: false
  sqrtPriceLimit: BigNumber
}
interface SwapToLowerPrice extends BaseSwapTestCase {
  zeroForOne: true
  sqrtPriceLimit: BigNumber
}
type SwapTestCase =
  | SwapExact0For1TestCase
  | Swap0ForExact1TestCase
  | SwapExact1For0TestCase
  | Swap1ForExact0TestCase
  | SwapToHigherPrice
  | SwapToLowerPrice

function swapCaseToDescription(testCase: SwapTestCase): string {
  const priceClause = testCase?.sqrtPriceLimit ? ` to price ${formatPrice(testCase.sqrtPriceLimit)}` : ''
  if ('exactOut' in testCase) {
    if (testCase.exactOut) {
      if (testCase.zeroForOne) {
        return `swap token0 for exactly ${formatTokenAmount(testCase.amount1)} token1${priceClause}`
      } else {
        return `swap token1 for exactly ${formatTokenAmount(testCase.amount0)} token0${priceClause}`
      }
    } else {
      if (testCase.zeroForOne) {
        return `swap exactly ${formatTokenAmount(testCase.amount0)} token0 for token1${priceClause}`
      } else {
        return `swap exactly ${formatTokenAmount(testCase.amount1)} token1 for token0${priceClause}`
      }
    }
  } else {
    if (testCase.zeroForOne) {
      return `swap token0 for token1${priceClause}`
    } else {
      return `swap token1 for token0${priceClause}`
    }
  }
}

type PoolFunctions = ReturnType<typeof createPoolFunctions>

// can't use address zero because the ERC20 token does not allow it
const SWAP_RECIPIENT_ADDRESS = constants.AddressZero.slice(0, -1) + '1'
const POSITION_PROCEEDS_OUTPUT_ADDRESS = constants.AddressZero.slice(0, -1) + '2'

async function executeSwap(
  pool: MockTimeUniswapV3Pool,
  testCase: SwapTestCase,
  poolFunctions: PoolFunctions
): Promise<ContractTransaction> {
  let swap: ContractTransaction
  if ('exactOut' in testCase) {
    if (testCase.exactOut) {
      if (testCase.zeroForOne) {
        swap = await poolFunctions.swap0ForExact1(testCase.amount1, SWAP_RECIPIENT_ADDRESS, testCase.sqrtPriceLimit)
      } else {
        swap = await poolFunctions.swap1ForExact0(testCase.amount0, SWAP_RECIPIENT_ADDRESS, testCase.sqrtPriceLimit)
      }
    } else {
      if (testCase.zeroForOne) {
        swap = await poolFunctions.swapExact0For1(testCase.amount0, SWAP_RECIPIENT_ADDRESS, testCase.sqrtPriceLimit)
      } else {
        swap = await poolFunctions.swapExact1For0(testCase.amount1, SWAP_RECIPIENT_ADDRESS, testCase.sqrtPriceLimit)
      }
    }
  } else {
    if (testCase.zeroForOne) {
      swap = await poolFunctions.swapToLowerPrice(testCase.sqrtPriceLimit, SWAP_RECIPIENT_ADDRESS)
    } else {
      swap = await poolFunctions.swapToHigherPrice(testCase.sqrtPriceLimit, SWAP_RECIPIENT_ADDRESS)
    }
  }
  return swap
}

const DEFAULT_POOL_SWAP_TESTS: SwapTestCase[] = []

interface Position {
  tickLower: number
  tickUpper: number
  liquidity: BigNumberish
}

interface PoolTestCase {
  description: string
  feeAmount: number
  tickSpacing: number
  startingPrice: BigNumber
  positions: Position[]
  swapTests?: SwapTestCase[]
}

const TEST_POOLS: PoolTestCase[] = [
  {
    description: 'high fee, 1:1 price, buggy swap calculation',
    feeAmount: FeeAmount.HIGH,
    tickSpacing: TICK_SPACINGS[FeeAmount.HIGH],
    //TickMath.getTickAtSqrtRatio(JSBI.BigInt('3905891053926514387903925684'))) = -60200
    startingPrice: BigNumber.from('3905891053926514387903925684'),
    positions: [
      {
        tickLower: -60200,
        tickUpper: 138200,
        liquidity: '1505426792435356595487',
      },
    ],
    swapTests: [{
      zeroForOne: true,
      exactOut: false,
      amount0: expandTo18Decimals(1),
    }],
  },
  {
    description: 'high fee, 1:1 price, default config',
    feeAmount: FeeAmount.HIGH,
    tickSpacing: TICK_SPACINGS[FeeAmount.HIGH],
    startingPrice: encodePriceSqrt(1, 1),
    positions: [
      {
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.HIGH]),
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.HIGH]),
        liquidity: expandTo18Decimals(2),
      },
    ],
    swapTests: [{
      zeroForOne: true,
      exactOut: false,
      amount0: expandTo18Decimals(1),
    }],
  },
]

describe.only('UniswapV3Pool swap tests', () => {
  let wallet: Wallet, other: Wallet

  let loadFixture: ReturnType<typeof createFixtureLoader>

  before('create fixture loader', async () => {
    ;[wallet, other] = await (ethers as any).getSigners()

    loadFixture = createFixtureLoader([wallet])
  })

  for (const poolCase of TEST_POOLS) {
    describe(poolCase.description, () => {
      const poolCaseFixture = async () => {
        const {
          createPool,
          token0,
          token1,
          swapTargetCallee: swapTarget,
        } = await poolFixture([wallet], waffle.provider)
        const pool = await createPool(poolCase.feeAmount, poolCase.tickSpacing)
        const poolFunctions = createPoolFunctions({ swapTarget, token0, token1, pool })
        await pool.initialize(poolCase.startingPrice)
        // mint all positions
        for (const position of poolCase.positions) {
          await poolFunctions.mint(wallet.address, position.tickLower, position.tickUpper, position.liquidity)
        }

        const [poolBalance0, poolBalance1] = await Promise.all([
          token0.balanceOf(pool.address),
          token1.balanceOf(pool.address),
        ])

        return { token0, token1, pool, poolFunctions, poolBalance0, poolBalance1, swapTarget }
      }

      let token0: TestERC20
      let token1: TestERC20

      let poolBalance0: BigNumber
      let poolBalance1: BigNumber

      let pool: MockTimeUniswapV3Pool
      let swapTarget: TestUniswapV3Callee
      let poolFunctions: PoolFunctions

      beforeEach('load fixture', async () => {
        ;({ token0, token1, pool, poolFunctions, poolBalance0, poolBalance1, swapTarget } = await loadFixture(
          poolCaseFixture
        ))
      })

      for (const testCase of poolCase.swapTests ?? DEFAULT_POOL_SWAP_TESTS) {
        it(swapCaseToDescription(testCase), async () => {
          const slot0 = await pool.slot0()
          const liquidity = await pool.liquidity();
          const tickUpper = await pool.ticks(138200);
          const tickLower = await pool.ticks(-60200);
          const token0Address = await pool.token0();
          const token1Address = await pool.token1();
          // console.log('tickUpper', tickUpper)
          // console.log('tickLower', tickLower)
          const tx = executeSwap(pool, testCase, poolFunctions)
          try {
            await tx
          } catch (error) {
            expect({
              swapError: error.message,
              poolBalance0: poolBalance0.toString(),
              poolBalance1: poolBalance1.toString(),
              poolPriceBefore: formatPrice(slot0.sqrtPriceX96),
              tickBefore: slot0.tick,
            }).to.matchSnapshot('swap error')
            return
          }
          const [
            poolBalance0After,
            poolBalance1After,
            slot0After,
            liquidityAfter,
            feeGrowthGlobal0X128,
            feeGrowthGlobal1X128,
          ] = await Promise.all([
            token0.balanceOf(pool.address),
            token1.balanceOf(pool.address),
            pool.slot0(),
            pool.liquidity(),
            pool.feeGrowthGlobal0X128(),
            pool.feeGrowthGlobal1X128(),
          ])
          const poolBalance0Delta = poolBalance0After.sub(poolBalance0)
          const poolBalance1Delta = poolBalance1After.sub(poolBalance1)

          // check all the events were emitted corresponding to balance changes
          if (poolBalance0Delta.eq(0)) await expect(tx).to.not.emit(token0, 'Transfer')
          else if (poolBalance0Delta.lt(0))
            await expect(tx)
              .to.emit(token0, 'Transfer')
              .withArgs(pool.address, SWAP_RECIPIENT_ADDRESS, poolBalance0Delta.mul(-1))
          else await expect(tx).to.emit(token0, 'Transfer').withArgs(wallet.address, pool.address, poolBalance0Delta)

          if (poolBalance1Delta.eq(0)) await expect(tx).to.not.emit(token1, 'Transfer')
          else if (poolBalance1Delta.lt(0))
            await expect(tx)
              .to.emit(token1, 'Transfer')
              .withArgs(pool.address, SWAP_RECIPIENT_ADDRESS, poolBalance1Delta.mul(-1))
          else await expect(tx).to.emit(token1, 'Transfer').withArgs(wallet.address, pool.address, poolBalance1Delta)

          // check that the swap event was emitted too
          await expect(tx)
            .to.emit(pool, 'Swap')
            .withArgs(
              swapTarget.address,
              SWAP_RECIPIENT_ADDRESS,
              poolBalance0Delta,
              poolBalance1Delta,
              slot0After.sqrtPriceX96,
              liquidityAfter,
              slot0After.tick
            )

          const executionPrice = new Decimal(poolBalance1Delta.toString()).div(poolBalance0Delta.toString()).mul(-1)

          console.log("result", {
            amount0Before: poolBalance0.toString(),
            amount1Before: poolBalance1.toString(),
            amount0Delta: poolBalance0Delta.toString(),
            amount1Delta: poolBalance1Delta.toString(),
            feeGrowthGlobal0X128Delta: feeGrowthGlobal0X128.toString(),
            feeGrowthGlobal1X128Delta: feeGrowthGlobal1X128.toString(),
            tickBefore: slot0.tick,
            poolPriceBefore: formatPrice(slot0.sqrtPriceX96),
            tickAfter: slot0After.tick,
            poolPriceAfter: formatPrice(slot0After.sqrtPriceX96),
            executionPrice: executionPrice.toPrecision(5),
          });
          const tokenA = new Token(
            1,
            token0Address,
            18,
            'A',
          );
          const tokenB = new Token(
            1,
            token1Address,
            18,
            'B',
          );
          const poolJs = new Pool(
            tokenA,
            tokenB,
            10000,
            JSBI.BigInt(slot0.sqrtPriceX96),
            JSBI.BigInt(liquidity),
            slot0.tick,
            [{
              index: poolCase.positions[0].tickLower,
              liquidityNet: JSBI.BigInt(tickLower.liquidityNet.toString()),
              liquidityGross: JSBI.BigInt(tickLower.liquidityGross.toString()),
            }, 
            {
              index: poolCase.positions[0].tickUpper,
              liquidityNet: JSBI.BigInt(tickUpper.liquidityNet.toString()),
              liquidityGross: JSBI.BigInt(tickUpper.liquidityGross.toString()),
            }],
          );
          const tokenIn = tokenA.address.toLowerCase() < tokenB.address.toLowerCase() ? tokenA : tokenB;
          const inputAmount = CurrencyAmount.fromRawAmount(tokenIn, (testCase as any).amount0.toString());
          const outputJs = await poolJs.getOutputAmount(inputAmount);
          console.log('contract swap price', executionPrice.toPrecision(5))
          console.log("outputJs price", outputJs[0].toSignificant(5))
          const swapDiff = parseFloat(executionPrice.toPrecision(5)) / parseFloat(outputJs[0].toSignificant(5));
          console.log("diff", parseFloat(executionPrice.toPrecision(5)) / parseFloat(outputJs[0].toSignificant(5)));
          expect(swapDiff).to.lt(1.001).gt(0.999);
        })
      }
    })
  }
})

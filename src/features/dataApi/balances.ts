import { skipToken } from '@reduxjs/toolkit/dist/query'
import { Currency, CurrencyAmount, Token } from '@uniswap/sdk-core'
import { graphql } from 'babel-plugin-relay/macro'
import { useMemo } from 'react'
import { useLazyLoadQuery } from 'react-relay'
import { useAppSelector } from 'src/app/hooks'
import { ChainId } from 'src/constants/chains'
import { PollingInterval } from 'src/constants/misc'
import {
  TESTNET_BALANCE_AMOUNT,
  TESTNET_BALANCE_USD,
  TESTNET_RELATIVE_CHANGE_24,
} from 'src/features/dataApi/constants'
import { dataApi, useBalancesQuery } from 'src/features/dataApi/slice'
import {
  ChainIdToCurrencyIdToPortfolioBalance,
  PortfolioBalance,
  PortfolioBalances,
  SerializablePortfolioBalance,
} from 'src/features/dataApi/types'
import { balancesQuery } from 'src/features/dataApi/__generated__/balancesQuery.graphql'
import { isEnabled } from 'src/features/remoteConfig'
import { TestConfig } from 'src/features/remoteConfig/testConfigs'
import { useAllCurrencies } from 'src/features/tokens/useTokens'
import { useActiveAccount } from 'src/features/wallet/hooks'
import { selectHideSmallBalances } from 'src/features/wallet/selectors'
import { fromGraphQLChain, isTestnet } from 'src/utils/chainId'
import { buildCurrencyId, currencyId, CurrencyId } from 'src/utils/currencyId'
import { flattenObjectOfObjects } from 'src/utils/objects'
import { percentDifference } from 'src/utils/statistics'

function useChainBalances(
  chainId: ChainId,
  address: Address | undefined,
  // Currencies that the app knows about and tracks
  // This is mostly to ensure we surface high quality tokens,
  // and avoid displaying scam tokens
  knownCurrencies: Record<CurrencyId, Currency> = {}
): {
  balances: { [currency: CurrencyId]: PortfolioBalance }
  loading: boolean
} {
  const ignoreSmallBalances = useAppSelector(selectHideSmallBalances)

  const { currentData: data, isLoading: loading } = useBalancesQuery(
    address ? { chainId, address, ignoreSmallBalances } : skipToken,
    {
      pollingInterval: PollingInterval.Slow,
    }
  )

  return useMemo(
    () => ({
      loading,
      balances: !data
        ? {}
        : // Filter out unknown currencies and transform output for ease of use
          formatSerializedBalanceItems(data, chainId, knownCurrencies),
    }),
    [chainId, knownCurrencies, data, loading]
  )
}

const query = graphql`
  query balancesQuery($ownerAddress: String!) {
    portfolios(ownerAddresses: [$ownerAddress]) {
      tokenBalances {
        quantity
        denominatedValue {
          currency
          value
        }
        token {
          chain
          address
          name
          symbol
          decimals
        }
        tokenProjectMarket {
          relativeChange24: pricePercentChange(duration: DAY) {
            value
          }
        }
      }
    }
  }
`
export function usePortfolioBalances(address: Address, onlyKnownCurrencies?: boolean) {
  const balancesData = useLazyLoadQuery<balancesQuery>(query, { ownerAddress: address })
  const balancesForAddress = balancesData?.portfolios?.[0]?.tokenBalances
  const tokensByChainId = useAllCurrencies()

  return useMemo(() => {
    if (!balancesForAddress) return

    const byId: Record<CurrencyId, PortfolioBalance> = {}
    balancesForAddress.forEach((balance) => {
      const chainId = fromGraphQLChain(balance?.token?.chain)

      // require all of these fields to be defined
      if (
        !chainId ||
        !balance ||
        !balance.quantity ||
        !balance.denominatedValue ||
        !balance.denominatedValue.value ||
        !balance.token ||
        !balance.token.address ||
        !balance.token.decimals
      )
        return

      const id = buildCurrencyId(chainId, balance.token.address)
      const knownCurrency = tokensByChainId[chainId]?.[id]

      if (onlyKnownCurrencies && !knownCurrency) return

      const currency =
        knownCurrency ??
        new Token(
          chainId,
          balance.token.address,
          balance.token.decimals,
          balance.token.symbol ?? undefined,
          balance.token.name ?? undefined
        )

      const portfolioBalance: PortfolioBalance = {
        amount: CurrencyAmount.fromRawAmount(
          currency,
          balance.quantity * 10 ** balance.token.decimals
        ),
        balanceUSD: balance.denominatedValue.value,
        relativeChange24: balance.tokenProjectMarket?.relativeChange24?.value ?? 0,
      }

      byId[id] = portfolioBalance
    })

    return byId
  }, [balancesForAddress, onlyKnownCurrencies, tokensByChainId])
}

export function useAllBalancesByChainId(
  address: Address | undefined,
  chainIds: ChainId[]
): {
  balances: ChainIdToCurrencyIdToPortfolioBalance
  loading: boolean
} {
  let balancesByChainId: ChainIdToCurrencyIdToPortfolioBalance | null = null
  let loading = false

  const tokensByChainId = useAllCurrencies()

  for (const chainId of chainIds) {
    balancesByChainId ??= {}

    // chainIds content is stable
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const balances = useChainBalances(chainId, address, tokensByChainId[chainId])

    if (isTestnet(chainId)) {
      balancesByChainId[chainId] = Object.keys(tokensByChainId[chainId] ?? {}).reduce<
        Record<CurrencyId, PortfolioBalance>
      >((memo, id) => {
        const currency = tokensByChainId[chainId]?.[id]
        if (currency) {
          memo[id] = {
            amount: CurrencyAmount.fromRawAmount(
              currency,
              TESTNET_BALANCE_AMOUNT * 10 ** currency.decimals
            ),
            balanceUSD: TESTNET_BALANCE_USD,
            relativeChange24: TESTNET_RELATIVE_CHANGE_24,
          }
        }
        return memo
      }, {})
      continue
    }

    balancesByChainId[chainId] = balances.balances
    loading = loading || balances.loading
  }

  return useMemo(
    () => ({
      balances: balancesByChainId ?? {},
      loading,
    }),
    [balancesByChainId, loading]
  )
}

/**
 * Retrieves balance for a single currency from the API cache.
 * Assumes the input currency is a known token.
 */
export function useSingleBalance(currency: NullUndefined<Currency>): PortfolioBalance | null {
  const address = useActiveAccount()?.address
  const hideSmallBalances = useAppSelector(selectHideSmallBalances)
  const balance = dataApi.endpoints.balances.useQueryState(
    address && currency
      ? {
          chainId: currency.chainId,
          address,
          ignoreSmallBalances: hideSmallBalances,
        }
      : skipToken,
    {
      // selectFromResult allows for performant re-renders
      selectFromResult: ({ data }) => data?.[currencyId(currency!)],
    }
  )

  return useMemo(
    () =>
      balance && currency
        ? {
            amount: CurrencyAmount.fromRawAmount(currency, balance.balance),
            balanceUSD: balance.balanceUSD,
            relativeChange24: percentDifference(balance.quote_rate, balance.quote_rate_24h),
          }
        : null,
    [balance, currency]
  )
}

/** Returns all balances as a flat list */
export function useAllBalancesList(
  address: Address | undefined,
  chainIds: ChainId[],
  count?: number
) {
  const { balances: balancesByChain, loading } = useAllBalancesByChainId(address, chainIds)

  return useMemo(() => {
    const allBalances = flattenObjectOfObjects(balancesByChain ?? {})
    return {
      balances: allBalances.sort((b1, b2) => b2.balanceUSD - b1.balanceUSD).slice(0, count),
      balancesByChain,
      totalCount: allBalances.length,
      loading,
    }
  }, [balancesByChain, count, loading])
}

function formatSerializedBalanceItems(
  data: {
    [currencyId: string]: SerializablePortfolioBalance
  },
  chainId: ChainId,
  knownCurrencies: Record<CurrencyId, Currency> = {}
) {
  const tokenBalancesQualityFilterEnabled = isEnabled(TestConfig.TokenBalancesQualityFilter)

  return Object.values(data).reduce<PortfolioBalances>(
    (portfolioBalances: PortfolioBalances, item: SerializablePortfolioBalance) => {
      const id = buildCurrencyId(chainId, item.contract_address)
      let currency = knownCurrencies[id]

      if (!tokenBalancesQualityFilterEnabled && !currency) {
        currency = new Token(chainId, item.contract_address, 0, item.contract_ticker_symbol)
      }

      if (currency) {
        portfolioBalances[id] = {
          amount: CurrencyAmount.fromRawAmount(currency, item.balance),
          balanceUSD: item.balanceUSD,
          relativeChange24: percentDifference(item.quote_rate, item.quote_rate_24h),
        }
      }
      return portfolioBalances
    },
    {}
  )
}

import { default as React, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { ListRenderItemInfo } from 'react-native'
import { useExploreStackNavigation } from 'src/app/navigation/types'
import { ChainId } from 'src/constants/chains'
import { useCoinIdAndCurrencyIdMappings } from 'src/features/dataApi/coingecko/hooks'
import { CoingeckoMarketCoin } from 'src/features/dataApi/coingecko/types'
import { SortingGroup } from 'src/features/explore/FilterGroup'
import {
  BaseTokenSectionProps,
  GenericTokenSection,
} from 'src/features/explore/GenericTokenSection'
import { useMarketTokens } from 'src/features/explore/hooks'
import { useOrderByModal } from 'src/features/explore/Modals'
import { TokenItem } from 'src/features/explore/TokenItem'
import { getOrderByValues } from 'src/features/explore/utils'
import { Screens } from 'src/screens/Screens'

/** Renders the top X tokens section on the Explore page */
export function TopTokensSection(props: BaseTokenSectionProps) {
  const { t } = useTranslation()
  const navigation = useExploreStackNavigation()

  const { orderBy, toggleModalVisible, orderByModal } = useOrderByModal()
  const { tokens: topTokens, isLoading } = useMarketTokens(
    useMemo(() => ({ ...getOrderByValues(orderBy), category: 'ethereum-ecosystem' }), [orderBy])
  )

  const { coinIdToCurrencyIds } = useCoinIdAndCurrencyIdMappings()

  const { onCycleMetadata, metadataDisplayType, expanded } = props

  const renderItem = useCallback(
    ({ item: token, index }: ListRenderItemInfo<CoingeckoMarketCoin>) => {
      // TODO: support non mainnet
      const currencyId = coinIdToCurrencyIds[token.id][ChainId.Mainnet]
      if (!currencyId) return null

      return (
        <TokenItem
          currencyId={currencyId}
          gesturesEnabled={!!expanded}
          index={index}
          metadataDisplayType={metadataDisplayType}
          token={token}
          onCycleMetadata={onCycleMetadata}
          onPress={() => {
            navigation.navigate(Screens.TokenDetails, {
              currencyId,
            })
          }}
        />
      )
    },
    [coinIdToCurrencyIds, expanded, metadataDisplayType, navigation, onCycleMetadata]
  )

  return (
    <>
      <GenericTokenSection
        {...props}
        assets={topTokens}
        id="explore-tokens-header"
        loading={isLoading}
        renderItem={renderItem}
        subtitle={props.expanded ? <SortingGroup onPressOrderBy={toggleModalVisible} /> : undefined}
        title={t('Tokens')}
      />
      {orderByModal}
    </>
  )
}

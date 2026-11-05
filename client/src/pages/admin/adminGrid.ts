import { type ColDef, themeQuartz, type ValueFormatterParams } from 'ag-grid-community'
import type { DisputeAction, OrderState } from '@campus/shared'
import { formatPrice } from '../../listings/format'
import { ORDER_STATE_LABELS } from '../../orders/orderStatus'

// What the admin dashboard's grids and panels share.

export const ACTION_LABELS: Record<DisputeAction, string> = {
  REFUND: 'Full refund',
  PARTIAL_REFUND: 'Partial refund',
  RELEASE: 'Release to seller',
  ESCALATE: 'Escalate',
}

/** AG Grid's Quartz theme in the app's colours (index.css tokens). */
export const gridTheme = themeQuartz.withParams({
  accentColor: '#4f46e5',
  foregroundColor: '#1f2140',
  borderColor: '#e1e4f2',
  headerBackgroundColor: '#eef0fa',
  backgroundColor: '#ffffff',
  fontFamily: 'inherit',
  browserColorScheme: 'light',
  wrapperBorderRadius: 12,
})

export const money = (p: ValueFormatterParams) => (typeof p.value === 'number' ? formatPrice(p.value) : '')
export const dateTime = (p: ValueFormatterParams) => (p.value ? new Date(p.value as string).toLocaleString() : '')
export const stateLabel = (p: ValueFormatterParams) => (p.value ? `${ORDER_STATE_LABELS[p.value as OrderState]} (${p.value})` : '')
export const shortId = (p: ValueFormatterParams) => (typeof p.value === 'string' ? p.value.slice(0, 8) : '')

export const defaultColDef: ColDef = { sortable: true, filter: true, resizable: true }

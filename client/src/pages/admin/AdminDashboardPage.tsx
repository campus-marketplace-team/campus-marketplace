import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AllCommunityModule,
  type ColDef,
  type GridApi,
  ModuleRegistry,
  type RowClickedEvent,
  themeQuartz,
  type ValueFormatterParams,
} from 'ag-grid-community'
import { AgGridReact } from 'ag-grid-react'
import type { OrderState } from '@campus/shared'
import { usePoll } from '../../chat/usePoll'
import { ApiError } from '../../api/client'
import {
  type AdminDashboard,
  type AdminOrder,
  type DeadLetter,
  fetchAdminDashboard,
  type ReconciliationFlag,
} from '../../admin/adminApi'
import { Alert, Button } from '../../components'
import { Page } from '../../layout/Page'
import { formatPrice } from '../../listings/format'
import { ORDER_STATE_LABELS } from '../../orders/orderStatus'
import './admin.css'

// Admin dashboard: orders by state, money held / captured / paid out from the
// ledger, reconciliation mismatches and dead-lettered outbox rows. Read-only.
// Refreshes every 30 s. All cells render as plain text (no HTML), since
// messages and payloads can contain anything.

ModuleRegistry.registerModules([AllCommunityModule])

const REFRESH_MS = 30_000

/** AG Grid's Quartz theme in the app's colours (index.css tokens). */
const gridTheme = themeQuartz.withParams({
  accentColor: '#4f46e5',
  foregroundColor: '#1f2140',
  borderColor: '#e1e4f2',
  headerBackgroundColor: '#eef0fa',
  backgroundColor: '#ffffff',
  fontFamily: 'inherit',
  browserColorScheme: 'light',
  wrapperBorderRadius: 12,
})

const money = (p: ValueFormatterParams) => (typeof p.value === 'number' ? formatPrice(p.value) : '')
const dateTime = (p: ValueFormatterParams) => (p.value ? new Date(p.value as string).toLocaleString() : '')
const stateLabel = (p: ValueFormatterParams) => (p.value ? `${ORDER_STATE_LABELS[p.value as OrderState]} (${p.value})` : '')
const shortId = (p: ValueFormatterParams) => (typeof p.value === 'string' ? p.value.slice(0, 8) : '')

const defaultColDef: ColDef = { sortable: true, filter: true, resizable: true }

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string; last?: AdminDashboard }
  | { status: 'ready'; data: AdminDashboard }

export function AdminDashboardPage() {
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [stateFilter, setStateFilter] = useState<OrderState | null>(null)

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const data = await fetchAdminDashboard(signal)
      setState({ status: 'ready', data })
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      const message = err instanceof ApiError ? err.message : 'Could not load the dashboard.'
      setState((prev) => ({ status: 'error', message, last: prev.status === 'ready' ? prev.data : prev.status === 'error' ? prev.last : undefined }))
    }
  }, [])
  usePoll(load, REFRESH_MS)

  const data = state.status === 'ready' ? state.data : state.status === 'error' ? state.last : undefined

  return (
    <Page
      title="Admin dashboard"
      description={data ? `Updated ${new Date(data.generatedAt).toLocaleTimeString()} · refreshes every 30 seconds` : undefined}
      actions={
        <Button variant="secondary" size="sm" onClick={() => void load()}>
          Refresh
        </Button>
      }
    >
      {state.status === 'error' && <Alert tone="error">{state.message}</Alert>}
      {state.status === 'loading' && (
        <p className="page-status" role="status">
          Loading…
        </p>
      )}
      {data && <Dashboard data={data} stateFilter={stateFilter} onStateFilter={setStateFilter} />}
    </Page>
  )
}

function Dashboard({
  data,
  stateFilter,
  onStateFilter,
}: {
  data: AdminDashboard
  stateFilter: OrderState | null
  onStateFilter: (s: OrderState | null) => void
}) {
  const orders = useMemo(
    () => (stateFilter ? data.orders.filter((o) => o.state === stateFilter) : data.orders),
    [data.orders, stateFilter],
  )

  return (
    <div className="admin">
      <section aria-labelledby="money-heading">
        <h2 id="money-heading" className="admin__heading">
          Money (from the ledger)
        </h2>
        <div className="admin__tiles">
          <Tile label="Held in escrow" cents={data.money.held} hint="Authorized, not captured" />
          <Tile label="Captured" cents={data.money.captured} hint="Taken from buyers, net of refunds" />
          <Tile label="Paid out" cents={data.money.paidOut} hint="Sent to sellers" />
          <Tile label="Owed to sellers" cents={data.money.sellerPayable} hint="Captured, payout not done" />
          <Tile label="Platform fees" cents={data.money.platformFees} hint="Kept by us" />
        </div>
      </section>

      <div className="admin__row">
        <section className="admin__state-panel" aria-labelledby="states-heading">
          <h2 id="states-heading" className="admin__heading">
            Orders by state <span className="admin__count">{data.orderCount}</span>
          </h2>
          <p className="text-muted admin__hint">Click a state to filter the orders below.</p>
          <StateGrid rows={data.ordersByState} selected={stateFilter} onSelect={onStateFilter} />
        </section>

        <section className="admin__orders-panel" aria-labelledby="orders-heading">
          <h2 id="orders-heading" className="admin__heading">
            Orders{stateFilter ? ` · ${ORDER_STATE_LABELS[stateFilter]}` : ''}
            {stateFilter && (
              <Button variant="ghost" size="sm" onClick={() => onStateFilter(null)}>
                Show all
              </Button>
            )}
          </h2>
          <p className="text-muted admin__hint">
            {stateFilter ? `${orders.length} shown of the` : 'The'} latest {data.orders.length} of {data.orderCount} by last
            change. Money columns are each order's ledger totals.
          </p>
          <OrdersGrid rows={orders} />
        </section>
      </div>

      <section aria-labelledby="flags-heading">
        <h2 id="flags-heading" className="admin__heading">
          Reconciliation mismatches <span className={data.openFlagCount ? 'admin__count admin__count--alert' : 'admin__count'}>{data.openFlagCount} open</span>
        </h2>
        <p className="text-muted admin__hint">Ledger vs PayPal, checked every 5 minutes. Open first; resolved ones clear when the two agree again.</p>
        <FlagsGrid rows={data.flags} />
      </section>

      <section aria-labelledby="dead-heading">
        <h2 id="dead-heading" className="admin__heading">
          Dead-letter outbox <span className={data.deadLetterCount ? 'admin__count admin__count--alert' : 'admin__count'}>{data.deadLetterCount}</span>
        </h2>
        <p className="text-muted admin__hint">Side effects that failed 5 times and won't be retried automatically.</p>
        <DeadLetterGrid rows={data.deadLetters} />
      </section>
    </div>
  )
}

function Tile({ label, cents, hint }: { label: string; cents: number; hint: string }) {
  return (
    <div className="admin-tile">
      <div className="admin-tile__label">{label}</div>
      <div className="admin-tile__value">{formatPrice(cents)}</div>
      <div className="admin-tile__hint">{hint}</div>
    </div>
  )
}

type StateRow = AdminDashboard['ordersByState'][number]

function StateGrid({ rows, selected, onSelect }: { rows: StateRow[]; selected: OrderState | null; onSelect: (s: OrderState | null) => void }) {
  const gridApi = useRef<GridApi<StateRow> | null>(null)
  // AG Grid caches row classes; redraw so the highlight follows the selection.
  useEffect(() => {
    gridApi.current?.redrawRows()
  }, [selected])

  const columns = useMemo<ColDef<StateRow>[]>(
    () => [
      // Raw state names fit the narrow panel; the friendly label is in the tooltip.
      {
        field: 'state',
        headerName: 'State',
        flex: 1,
        minWidth: 150,
        tooltipValueGetter: (p) => (p.value ? ORDER_STATE_LABELS[p.value as OrderState] : ''),
      },
      { field: 'count', headerName: 'Orders', width: 95, type: 'numericColumn', sort: 'desc' },
    ],
    [],
  )
  return (
    <AgGridReact<StateRow>
      theme={gridTheme}
      rowData={rows}
      columnDefs={columns}
      defaultColDef={{ sortable: true, resizable: true }}
      domLayout="autoHeight"
      getRowId={(p) => p.data.state}
      onGridReady={(e) => {
        gridApi.current = e.api
      }}
      rowClass="admin-grid__clickable"
      getRowClass={(p) => (p.data?.state === selected ? 'admin-grid__selected' : undefined)}
      onRowClicked={(e: RowClickedEvent<StateRow>) => e.data && onSelect(e.data.state === selected ? null : e.data.state)}
    />
  )
}

function OrdersGrid({ rows }: { rows: AdminOrder[] }) {
  const columns = useMemo<ColDef<AdminOrder>[]>(
    () => [
      { field: 'updatedAt', headerName: 'Last change', valueFormatter: dateTime, sort: 'desc', width: 215 },
      { field: 'state', headerName: 'State', valueFormatter: stateLabel, width: 220 },
      { field: 'listingTitle', headerName: 'Listing', width: 180 },
      { field: 'buyer', headerName: 'Buyer', width: 130 },
      { field: 'seller', headerName: 'Seller', width: 130 },
      { field: 'amountCents', headerName: 'Amount', valueFormatter: money, type: 'numericColumn', width: 110 },
      { field: 'ledger.held', headerName: 'Held', valueFormatter: money, type: 'numericColumn', width: 105 },
      { field: 'ledger.captured', headerName: 'Captured', valueFormatter: money, type: 'numericColumn', width: 115 },
      { field: 'ledger.paidOut', headerName: 'Paid out', valueFormatter: money, type: 'numericColumn', width: 110 },
      { field: 'payoutAttempts', headerName: 'Payout tries', type: 'numericColumn', width: 120 },
      { field: 'payoutLastError', headerName: 'Payout note', width: 240, tooltipField: 'payoutLastError' },
      { field: 'id', headerName: 'Order', valueFormatter: shortId, width: 110, tooltipField: 'id' },
    ],
    [],
  )
  return (
    <div className="admin-grid admin-grid--tall">
      <AgGridReact<AdminOrder>
        theme={gridTheme}
        rowData={rows}
        columnDefs={columns}
        defaultColDef={defaultColDef}
        getRowId={(p) => p.data.id}
        pagination
        paginationPageSize={50}
        paginationPageSizeSelector={[25, 50, 100]}
        overlayNoRowsTemplate="No orders"
      />
    </div>
  )
}

function FlagsGrid({ rows }: { rows: ReconciliationFlag[] }) {
  const columns = useMemo<ColDef<ReconciliationFlag>[]>(
    () => [
      { field: 'status', headerName: 'Status', width: 110, cellClassRules: { 'admin-grid__alert': (p) => p.value === 'OPEN' } },
      { field: 'kind', headerName: 'Kind', width: 140 },
      { field: 'message', headerName: 'Mismatch', flex: 1, minWidth: 320, tooltipField: 'message' },
      { field: 'orderState', headerName: 'Order state', valueFormatter: stateLabel, width: 200 },
      { field: 'orderId', headerName: 'Order', valueFormatter: shortId, width: 110, tooltipField: 'orderId' },
      { field: 'firstSeenAt', headerName: 'First seen', valueFormatter: dateTime, width: 215 },
      { field: 'lastSeenAt', headerName: 'Last seen', valueFormatter: dateTime, width: 215 },
      { field: 'resolvedAt', headerName: 'Resolved', valueFormatter: dateTime, width: 215 },
    ],
    [],
  )
  return (
    <div className="admin-grid">
      <AgGridReact<ReconciliationFlag>
        theme={gridTheme}
        rowData={rows}
        columnDefs={columns}
        defaultColDef={defaultColDef}
        getRowId={(p) => p.data.id}
        overlayNoRowsTemplate="No mismatches: the ledger agrees with PayPal"
      />
    </div>
  )
}

function DeadLetterGrid({ rows }: { rows: DeadLetter[] }) {
  const columns = useMemo<ColDef<DeadLetter>[]>(
    () => [
      { field: 'createdAt', headerName: 'Created', valueFormatter: dateTime, sort: 'desc', width: 215 },
      { field: 'topic', headerName: 'Topic', width: 190 },
      { field: 'attempts', headerName: 'Attempts', type: 'numericColumn', width: 110 },
      { field: 'lastError', headerName: 'Last error', flex: 1, minWidth: 280, tooltipField: 'lastError' },
      { field: 'orderId', headerName: 'Order', valueFormatter: shortId, width: 110, tooltipField: 'orderId' },
      { field: 'payload', headerName: 'Payload', width: 260, tooltipField: 'payload' },
    ],
    [],
  )
  return (
    <div className="admin-grid">
      <AgGridReact<DeadLetter>
        theme={gridTheme}
        rowData={rows}
        columnDefs={columns}
        defaultColDef={defaultColDef}
        getRowId={(p) => p.data.id}
        overlayNoRowsTemplate="No dead letters"
      />
    </div>
  )
}

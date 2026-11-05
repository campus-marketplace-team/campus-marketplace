import { useMemo, useRef, useState, type ReactNode } from 'react'
import { type ColDef, type GridApi, type ValueFormatterParams } from 'ag-grid-community'
import { AgGridReact } from 'ag-grid-react'
import type { DisputeAction } from '@campus/shared'
import type { AdminDashboard, DisputeDecisionRecord, RiskDecisionRecord, RiskFeatures } from '../../admin/adminApi'
import { Button } from '../../components'
import { formatPrice } from '../../listings/format'
import { ACTION_LABELS, dateTime, defaultColDef, gridTheme, money, shortId, stateLabel } from './adminGrid'

// The AI decision records: what the risk engine decided before each checkout, and
// every dispute decision and how it ended. Read-only: approving and rejecting happen
// in the queue (DisputeQueues.tsx). A row's long text opens in a panel below its grid.
//
// Reasons, reasoning and evidence are model output that can quote what a buyer or
// seller wrote, so they only ever render as plain text.

const RISK_OUTCOME_LABELS: Record<RiskDecisionRecord['outcome'], string> = {
  NORMAL: 'Normal',
  HOLD_WITH_WARNING: 'Longer hold, warning',
  BLOCKED: 'Blocked',
}

const ACTION_STATUS_LABELS: Record<NonNullable<DisputeDecisionRecord['actionStatus']>, string> = {
  PENDING_APPROVAL: 'Waiting for approval',
  APPROVED: 'Approved, running',
  EXECUTED: 'Done',
  REJECTED: 'Rejected',
  FAILED: 'Failed',
}

const riskOutcome = (p: ValueFormatterParams) => (p.value ? RISK_OUTCOME_LABELS[p.value as RiskDecisionRecord['outcome']] : '')
const disputeAction = (p: ValueFormatterParams) => (p.value ? ACTION_LABELS[p.value as DisputeAction] : '')
const actionStatus = (p: ValueFormatterParams) => (p.value ? ACTION_STATUS_LABELS[p.value as keyof typeof ACTION_STATUS_LABELS] : '')
const list = (p: ValueFormatterParams) => (Array.isArray(p.value) ? p.value.join(', ') : '')

/** Who cleared a decision. No approver but an approval time means it never needed one: under the limit, or an escalation. */
function reviewedBy(d: DisputeDecisionRecord) {
  if (d.approver) return d.approver
  return d.approvedAt ? 'Not needed' : ''
}

const proposedBy = (d: DisputeDecisionRecord) => (d.proposedByAgent ? (d.model ?? 'Dispute agent') : 'An admin')

/** The grid plus the panel for its selected row. The row is looked up by id, so a refresh keeps both current. */
function RecordsGrid<Row extends { id: string }>({
  rows,
  columns,
  emptyText,
  renderDetails,
}: {
  rows: Row[]
  columns: ColDef<Row>[]
  emptyText: string
  renderDetails: (row: Row) => ReactNode
}) {
  const gridApi = useRef<GridApi<Row> | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = selectedId ? rows.find((r) => r.id === selectedId) : undefined

  return (
    <>
      <div className="admin-grid">
        <AgGridReact<Row>
          theme={gridTheme}
          rowData={rows}
          columnDefs={columns}
          defaultColDef={defaultColDef}
          getRowId={(p) => p.data.id}
          rowSelection={{ mode: 'singleRow', checkboxes: false, enableClickSelection: true }}
          onGridReady={(e) => {
            gridApi.current = e.api
          }}
          onSelectionChanged={(e) => setSelectedId(e.api.getSelectedRows()[0]?.id ?? null)}
          rowClass="admin-grid__clickable"
          overlayNoRowsTemplate={emptyText}
        />
      </div>
      {selected && (
        <div className="decision-panel">
          <div className="decision-panel__close">
            <Button variant="ghost" size="sm" onClick={() => gridApi.current?.deselectAll()}>
              Close
            </Button>
          </div>
          {renderDetails(selected)}
        </div>
      )}
    </>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="decision-panel__field">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

function OrderFields({ row }: { row: RiskDecisionRecord | DisputeDecisionRecord }) {
  return (
    <>
      <Field label="Listing">{row.listingTitle ?? '—'}</Field>
      <Field label="Amount">{row.orderAmountCents === null ? '—' : formatPrice(row.orderAmountCents)}</Field>
      <Field label="Buyer">{row.buyer ?? '—'}</Field>
      <Field label="Seller">{row.seller ?? '—'}</Field>
      <Field label="Order">{row.orderId ?? '—'}</Field>
    </>
  )
}

function featureLines(f: RiskFeatures) {
  const { price } = f
  const ratio = price.ratioToMedian === null ? 'too few comparable listings' : `${price.ratioToMedian} × the ${formatPrice(price.categoryMedianCents ?? 0)} category median`
  const phrases = [...new Set(f.offPlatformPhrases.map((p) => `${p.phrase} (${p.sender})`))]
  return [
    ['Seller account age', `${f.sellerAccountAgeDays} days`],
    ['Seller listings, last 24 hours', String(f.sellerListingsLast24h)],
    ['Price', `${formatPrice(price.amountCents)}: ${ratio}`],
    ['Seller past disputes', String(f.sellerPastDisputes)],
    ['Buyer past disputes', String(f.buyerPastDisputes)],
    ['Off-platform phrases in chat', phrases.length ? phrases.join(', ') : 'None'],
  ]
}

function RiskDetails({ row }: { row: RiskDecisionRecord }) {
  const classifier = row.classifierFallbackReason
    ? `Failed (${row.classifierFallbackReason}), so ${row.classifierRisk ?? 'medium'} was assumed`
    : (row.classifierRisk ?? '—')
  return (
    <>
      <h3 className="decision-panel__title">
        {RISK_OUTCOME_LABELS[row.outcome]} · {row.risk ?? 'unknown'} risk
      </h3>
      {row.reasoning && <p className="decision-panel__text">{row.reasoning}</p>}
      <dl className="decision-panel__fields">
        <OrderFields row={row} />
        <Field label="Classifier said">{classifier}</Field>
        <Field label="Hard rule floor">{row.floor ?? '—'}</Field>
        <Field label="Hard rules fired">{row.hardRules.join(', ') || 'None'}</Field>
        <Field label="Signals">{row.signals.join(', ') || 'None'}</Field>
        <Field label="Model">{row.model ?? '—'}</Field>
        {row.features && featureLines(row.features).map(([label, value]) => <Field key={label} label={label}>{value}</Field>)}
      </dl>
      <h4 className="decision-panel__subtitle">Classifier's reasons (model output: may quote the listing or chat)</h4>
      {row.reasons.length > 0 ? (
        <ul className="decision-panel__list">
          {row.reasons.map((reason, i) => (
            <li key={i}>{reason}</li>
          ))}
        </ul>
      ) : (
        <p className="text-muted">None recorded.</p>
      )}
    </>
  )
}

function DisputeDetails({ row }: { row: DisputeDecisionRecord }) {
  const when = (value: string | null) => (value ? new Date(value).toLocaleString() : '—')
  return (
    <>
      <h3 className="decision-panel__title">
        {ACTION_LABELS[row.outcome]}
        {row.outcome === 'PARTIAL_REFUND' && row.amountCents !== null ? ` of ${formatPrice(row.amountCents)}` : ''}
        {row.actionStatus ? ` · ${ACTION_STATUS_LABELS[row.actionStatus]}` : ''}
      </h3>
      {row.actionError && <p className="decision-panel__text decision-panel__error">{row.actionError}</p>}
      <dl className="decision-panel__fields">
        <OrderFields row={row} />
        <Field label="Proposed by">{proposedBy(row)}</Field>
        <Field label="Reviewed by">{reviewedBy(row) || '—'}</Field>
        <Field label="Proposed">{when(row.createdAt)}</Field>
        <Field label="Approved">{when(row.approvedAt)}</Field>
        <Field label="Rejected">{when(row.rejectedAt)}</Field>
        <Field label="Executed">{when(row.executedAt)}</Field>
        <Field label="PayPal transaction">{row.paypalTransactionId ?? '—'}</Field>
        {row.reviewNote && <Field label="Review note">{row.reviewNote}</Field>}
      </dl>
      <h4 className="decision-panel__subtitle">Reasoning (may quote the buyer or seller)</h4>
      <p className="decision-panel__text">{row.reasoning || 'None recorded.'}</p>
      <h4 className="decision-panel__subtitle">Evidence</h4>
      {row.evidence.length > 0 ? (
        <ul className="decision-panel__list">
          {row.evidence.map((item, i) => (
            <li key={i}>
              <span className="text-muted">{item.source}:</span> {item.detail}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted">None recorded.</p>
      )}
    </>
  )
}

export function AiDecisions({
  risk,
  riskCounts,
  disputes,
  disputeCounts,
}: {
  risk: RiskDecisionRecord[]
  riskCounts: AdminDashboard['riskDecisionCounts']
  disputes: DisputeDecisionRecord[]
  disputeCounts: AdminDashboard['disputeDecisionCounts']
}) {
  const riskColumns = useMemo<ColDef<RiskDecisionRecord>[]>(
    () => [
      { field: 'createdAt', headerName: 'Decided', valueFormatter: dateTime, sort: 'desc', width: 215 },
      { field: 'outcome', headerName: 'Outcome', valueFormatter: riskOutcome, width: 180, cellClassRules: { 'admin-grid__alert': (p) => p.value === 'BLOCKED' } },
      { field: 'risk', headerName: 'Risk', width: 100 },
      { field: 'hardRules', headerName: 'Hard rules', cellDataType: false, valueFormatter: list, width: 220, filterValueGetter: (p) => p.data?.hardRules.join(', ') },
      { field: 'signals', headerName: 'Signals', cellDataType: false, valueFormatter: list, width: 200, filterValueGetter: (p) => p.data?.signals.join(', ') },
      { field: 'listingTitle', headerName: 'Listing', width: 180 },
      { field: 'buyer', headerName: 'Buyer', width: 130 },
      { field: 'seller', headerName: 'Seller', width: 130 },
      { field: 'orderAmountCents', headerName: 'Amount', valueFormatter: money, type: 'numericColumn', width: 110 },
      { field: 'orderState', headerName: 'Order state now', valueFormatter: stateLabel, width: 220 },
      { field: 'model', headerName: 'Model', width: 170 },
      { field: 'orderId', headerName: 'Order', valueFormatter: shortId, width: 110, tooltipField: 'orderId' },
    ],
    [],
  )

  const disputeColumns = useMemo<ColDef<DisputeDecisionRecord>[]>(
    () => [
      { field: 'createdAt', headerName: 'Proposed', valueFormatter: dateTime, sort: 'desc', width: 215 },
      { field: 'outcome', headerName: 'Action', valueFormatter: disputeAction, width: 150 },
      { field: 'amountCents', headerName: 'Refund', valueFormatter: money, type: 'numericColumn', width: 105 },
      { field: 'actionStatus', headerName: 'Status', valueFormatter: actionStatus, width: 180, cellClassRules: { 'admin-grid__alert': (p) => p.value === 'FAILED' } },
      { colId: 'proposedBy', headerName: 'Proposed by', valueGetter: (p) => (p.data ? proposedBy(p.data) : ''), width: 170 },
      { colId: 'reviewedBy', headerName: 'Reviewed by', valueGetter: (p) => (p.data ? reviewedBy(p.data) : ''), width: 140 },
      { field: 'paypalTransactionId', headerName: 'PayPal transaction', width: 190, tooltipField: 'paypalTransactionId' },
      { field: 'listingTitle', headerName: 'Listing', width: 180 },
      { field: 'buyer', headerName: 'Buyer', width: 130 },
      { field: 'seller', headerName: 'Seller', width: 130 },
      { field: 'orderState', headerName: 'Order state now', valueFormatter: stateLabel, width: 220 },
      { field: 'orderId', headerName: 'Order', valueFormatter: shortId, width: 110, tooltipField: 'orderId' },
    ],
    [],
  )

  return (
    <>
      <section aria-labelledby="risk-decisions-heading">
        <h2 id="risk-decisions-heading" className="admin__heading">
          Risk decisions <span className={riskCounts.blocked ? 'admin__count admin__count--alert' : 'admin__count'}>{riskCounts.blocked} blocked</span>
          <span className="admin__count">{riskCounts.holdWithWarning} warned</span>
          <span className="admin__count">{riskCounts.normal} normal</span>
        </h2>
        <p className="text-muted admin__hint">
          Decided before checkout: the classifier can raise risk above the hard rules' floor, never lower it. Latest {risk.length} of {riskCounts.total}. Click a row for the
          details.
        </p>
        <RecordsGrid
          rows={risk}
          columns={riskColumns}
          emptyText="No risk decisions yet"
          renderDetails={(row) => <RiskDetails row={row} />}
        />
      </section>

      <section aria-labelledby="dispute-decisions-heading">
        <h2 id="dispute-decisions-heading" className="admin__heading">
          Dispute decision records{' '}
          <span className={disputeCounts.failed ? 'admin__count admin__count--alert' : 'admin__count'}>{disputeCounts.failed} failed</span>
        </h2>
        <p className="text-muted admin__hint">
          Every decision the agent or an admin made, and how it ended. To act on one waiting for approval, use the queue at the top. Latest {disputes.length} of {disputeCounts.total}. Click
          a row for the evidence and reasoning.
        </p>
        <RecordsGrid
          rows={disputes}
          columns={disputeColumns}
          emptyText="No dispute decisions yet"
          renderDetails={(row) => <DisputeDetails row={row} />}
        />
      </section>
    </>
  )
}

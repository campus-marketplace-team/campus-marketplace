import { BUYER_RISK_REASON_LABELS, type RiskHardRule } from '@campus/shared'
import './checkout.css'

/**
 * The checks behind a risk result, as fixed plain-English labels. Only our own
 * deterministic rules are listed: never the classifier's reasons or any chat text.
 */
export function RiskReasonList({ reasons }: { reasons: RiskHardRule[] }) {
  const labels = [...new Set(reasons.map((r) => BUYER_RISK_REASON_LABELS[r]).filter((l): l is string => !!l))]
  if (labels.length === 0) return null
  return (
    <>
      <span className="risk-reasons__lead">What our checks noticed:</span>
      <ul className="risk-reasons">
        {labels.map((label) => (
          <li key={label}>{label}</li>
        ))}
      </ul>
    </>
  )
}

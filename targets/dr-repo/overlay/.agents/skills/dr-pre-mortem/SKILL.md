---
name: dr-pre-mortem
description: "Run a pre-mortem risk analysis on a DR Platform phase, feature, or launch plan. Categorizes risks as Tigers (real problems), Paper Tigers (overblown concerns), and Elephants (unspoken worries), then classifies as launch-blocking, fast-follow, or track. Use when preparing for a pilot milestone, failover test, agent rollout, or identifying what could go wrong in production."
---

# DR Pre-Mortem: Risk Analysis for Launch / Pilot / Failover Milestone

## Purpose

You are a veteran product and reliability engineer conducting a pre-mortem on `$ARGUMENTS` for the DR Platform. This skill assumes the upcoming milestone (pilot deployment, failover test, agent rollout, or feature launch) has failed, and works backward to identify real risks, distinguish them from perceived worries, and create action plans to mitigate launch-blocking issues.

## Context

A pre-mortem is a structured risk-identification exercise that forces the team to think critically about what could go wrong *before* the milestone, when there's still time to act. By assuming failure, we surface hidden concerns and separate legitimate threats from overblown worries.

For the DR Platform, the stakes are especially high: a failed failover can mean customer data loss or extended downtime. Risks involving the Windows agent, Hyper-V VM replication, PostgreSQL streaming, and Headscale VPN must be evaluated with both product and operational lenses.

## Instructions

1. **Gather the Plan**: If the user provides a plan file (e.g., `docs/plans/.../PLAN.md`, active slice, or ROADMAP), read it thoroughly. Understand the milestone scope, target customer, key assumptions, and timeline. Use repo evidence (code, tests, migrations) to ground your analysis.

2. **Assume Failure**:
   - Imagine the milestone ships in 14 days
   - Now imagine it fails—the pilot customer cannot fail over, VMs do not boot, PostgreSQL replication lags cause data loss, the Windows agent crashes in a loop, or the VPN partition isolates the DR site
   - What went wrong?
   - What did we miss or not execute well?
   - What were we overconfident about?

3. **Categorize Risks**: Classify each potential failure as one of three types:

   **Tigers**: Real problems you see that could derail the milestone
   - Based on repo evidence, past incidents, or clear logic
   - Should keep the team awake at night
   - Require action before or immediately after launch

   **Paper Tigers**: Problems others might worry about, but you do not believe are likely
   - Valid concerns on the surface, but mitigated by design or unlikely in the pilot scope
   - Not worth significant resource investment
   - Worth documenting to align stakeholders

   **Elephants**: Something you are not sure is a problem, but the team is not discussing it enough
   - Unspoken concerns or assumptions nobody is validating
   - Could be real; you are unsure
   - Deserve investigation before the milestone

4. **Classify Tigers by Urgency**:

   **Launch-Blocking**: Must be solved before the milestone is declared ready
   - Example: Failover command does not actually start VMs, agent auto-update bricks the service, PostgreSQL WAL-G restore is untested on the target host

   **Fast-Follow**: Must be solved within 30 days post-launch
   - Example: Missing metrics for replication lag, no automated failback, Headscale key rotation is manual

   **Track**: Monitor post-launch; solve if it becomes an issue
   - Example: UI theming inconsistencies, non-English locale support, advanced alerting rules

5. **Create Action Plans**: For every Launch-Blocking Tiger:
   - Describe the risk clearly
   - Suggest a concrete mitigation action
   - Identify the best owner (engineering, ops, customer success)
   - Set a decision / completion date

6. **Structure Output**: Present the analysis as:

   ```
   ## Pre-Mortem Analysis: [Milestone Name]

   ### Tigers (Real Risks)
   [List each real risk with category and mitigation plan]

   ### Paper Tigers (Overblown Concerns)
   [List each, explain why it's not a true risk]

   ### Elephants (Unspoken Worries)
   [List each, recommend investigation approach]

   ### Action Plans for Launch-Blocking Tigers
   [For each, include: Risk, Mitigation, Owner, Due Date]
   ```

7. **Save the Output**: Save as a markdown document under `docs/plans/YYYY-MM-DD-<milestone-slug>/pre-mortem.md`

## Notes

- Be honest and constructive—the goal is to improve launch readiness, not assign blame
- Default to "Tiger" if unsure; it is better to address risks early in a disaster-recovery system
- Involve cross-functional perspectives (agent engineering, portal engineering, operations, customer-facing) in your analysis
- Revisit the pre-mortem 2-3 weeks before launch to verify mitigations are on track
- If the plan is non-trivial, consider running a Partner pass (strengthen readiness) and a Combatant pass (attack assumptions) as defined in `docs/AGENT_ROLES.md` before finalizing the analysis

---

### Further Reading

- [How Meta and Instagram Use Pre-Mortems to Avoid Post-Mortems](https://www.productcompass.pm/p/how-to-run-pre-mortem-template)
- [How to Manage Risks as a Product Manager](https://www.productcompass.pm/p/how-to-manage-risks-as-a-product-manager)

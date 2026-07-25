## Context

`runHubUpgradeControl` currently assigns `hubUpgrade:<room>` to every active RCL7 upgrader and always calls the shared boost-preparation flow for its remaining WORK parts. The role's `prepare` phase treats a missing or unready assigned lab as blocking, so an empty local XGH2O supply stalls upgrading indefinitely.

## Goals / Non-Goals

**Goals:**

- Only require XGH2O boost preparation when the upgrader's own room already holds enough XGH2O for its remaining unboosted WORK parts.
- Release a previously reserved boost task and omit its role argument when local stock is insufficient, allowing the existing creep role to become ready normally.
- Count XGH2O in storage, terminal, and room-owned labs so compounds already loaded into a boost lab remain usable.

**Non-Goals:**

- Do not request XGH2O from other rooms for hub upgrader boosts.
- Do not change power-bank or combat boost behavior.
- Do not interrupt a working upgrader later merely because local XGH2O becomes available.

## Decisions

- Evaluate local XGH2O in `hubUpgradeControl` before configuring the role. This is the only component that owns both the required amount and the boost-task lifecycle.
- Require enough compound for every remaining unboosted WORK part (`remainingWorkParts * LAB_BOOST_MINERAL`). Partial local stock falls back entirely to unboosted work, avoiding a later wait after partial boosting.
- Use `args: [roomName]` for the fallback configuration. The existing role already treats an absent boost task as immediately prepared, so no role-state or memory migration is required.
- Release the boost task whenever the fallback is selected. This removes lab reservations, carrier work, and synthesis pause left by a prior boost attempt.

## Risks / Trade-offs

- [T3 arrives after an unboosted creep is ready] → The creep continues upgrading unboosted; the next replacement can use T3. This avoids interrupting active work.
- [Local stock appears in multiple structures] → Sum storage, terminal, and owned labs to avoid falsely treating loaded lab mineral as absent.
- [Boost lab energy is unavailable] → Existing T3 boost readiness rules remain unchanged because this change only relaxes the XGH2O-shortage path.

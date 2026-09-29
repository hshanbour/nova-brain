import {randomUUID} from "node:crypto";

const USD_NANOS=1_000_000_000;
const usdToNanos=value=>Math.round(Number(value)*USD_NANOS);
const nanosToUsd=value=>Number(value)/USD_NANOS;

export class BrowserProviderBudgetError extends Error{
  constructor(code,message,safeDiagnostics={}){super(message);this.name="BrowserProviderBudgetError";this.code=code;this.safeDiagnostics=safeDiagnostics;}
}

export function createBrowserProviderBudget({storage,ownerId,budgetId="nova-browser-provider-v1",globalBudgetUsd=0.5,normalReservationUsd=0.01,heavyReservationUsd=0.02,pricePerHourUsd=0.09}={}){
  if(!storage||!ownerId)throw new Error("Browser provider budget dependencies are required.");
  const globalCapNanoUsd=usdToNanos(globalBudgetUsd);
  return Object.freeze({
    async reserve({taskId,runId,heavy=false}={}){
      const reservedNanoUsd=usdToNanos(heavy?heavyReservationUsd:normalReservationUsd);
      const reservation=await storage.reserveModelCost({id:randomUUID(),ownerId,budgetId,taskId:taskId||null,runId:runId||null,stage:"public_browser_read",model:"cloudflare-browser-run",reservedNanoUsd,globalCapNanoUsd,taskCapNanoUsd:reservedNanoUsd,metadata:{provider:"cloudflare",kind:"browser_session",heavy:heavy===true}});
      if(!reservation)throw new BrowserProviderBudgetError("browser_provider_budget_exhausted","Nova's browser-provider budget is insufficient for this bounded session.",{budgetId,authorizedUsd:globalBudgetUsd,reservationUsd:nanosToUsd(reservedNanoUsd)});
      return reservation;
    },
    async settle(reservation,{durationMs=0,status="settled"}={}){
      const actualNanoUsd=status==="released"?0:Math.min(reservation.reservedNanoUsd,Math.max(0,usdToNanos((Math.max(0,Number(durationMs))/3_600_000)*pricePerHourUsd)));
      await storage.settleModelCost(reservation.id,ownerId,{status,actualNanoUsd,usage:{provider:"cloudflare",durationMs:Math.max(0,Math.round(Number(durationMs)||0)),pricePerHourUsd,imputedCostUsd:nanosToUsd(actualNanoUsd)}});
      return Object.freeze({budgetId,status,durationMs:Math.max(0,Math.round(Number(durationMs)||0)),pricePerHourUsd,estimatedCostUsd:nanosToUsd(actualNanoUsd)});
    },
    async status(){const value=await storage.getModelCostBudget(ownerId,budgetId);return Object.freeze({budgetId,authorizedUsd:globalBudgetUsd,spentUsd:nanosToUsd(value?.spentNanoUsd||0),reservedUsd:nanosToUsd(value?.reservedNanoUsd||0),remainingUsd:Math.max(0,globalBudgetUsd-nanosToUsd((value?.spentNanoUsd||0)+(value?.reservedNanoUsd||0)))});},
  });
}

import type {
  DownloadCreditFinalizationResult,
  DownloadCreditReservationResult,
  DownloadCreditSnapshot,
} from "./download-credits.js";

export function serializeDownloadCreditSnapshot(snapshot: DownloadCreditSnapshot) {
  return {
    availableCredits: snapshot.balance,
    reservedCredits: snapshot.reserved,
    totalGrantedCredits: snapshot.granted,
    totalSpentCredits: snapshot.spent,
    starterCredits: snapshot.starterGrant,
    costs: snapshot.costs,
  };
}

export function serializeDownloadCreditReservation(result: DownloadCreditReservationResult) {
  return {
    ...serializeDownloadCreditSnapshot(result),
    allowed: result.allowed,
    reservationKey: result.reservationKey,
    reservationStatus: result.status,
    creditCost: result.creditCost,
  };
}

export function serializeDownloadCreditFinalization(result: DownloadCreditFinalizationResult) {
  return {
    ...serializeDownloadCreditSnapshot(result),
    found: result.found,
    reservationKey: result.reservationKey,
    reservationStatus: result.status,
    creditCost: result.creditCost,
  };
}

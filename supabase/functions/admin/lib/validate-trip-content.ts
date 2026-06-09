// Re-export the shared structural validator (see _shared/trip-content-validate.ts)
// so the admin content-review path and the customer trips path stay in lockstep.
export { validateTripContent } from '../../_shared/trip-content-validate.ts';

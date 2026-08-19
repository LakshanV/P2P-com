// PLANTED VIOLATION: L7 imports L7 — sibling call inside a layer.
import { disputes } from '../disputes/index.ts';
export const returns = disputes;

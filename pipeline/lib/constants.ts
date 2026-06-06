// Pipeline constants — tunable design parameters for the Gardener/Implementer.

/** Maximum number of cardinal connections a zone may have before the Gardener
 *  is blocked from proposing new_zone off it. Kept high to favour depth-over-
 *  breadth; the deepen_candidates signal handles the depth side. */
export const MAX_BRANCHING_FACTOR = 10;

### Village notes: 
1. ✅ FIXED: Fountain overlapping with tavern and other plots
   - Reduced fountain size from 7×7 to 5×5
   - Added clear operation (12×12 area) around fountain to prevent building overlap

2. ✅ FIXED: Towers and walls need gates
   - Added wall_gates constraint with door tiles at cardinal points (N, E, S, W)

3. ✅ FIXED: Need to add a market / bazaar area / open space
   - Added market_square constraint: 9×9 area with stone/wood floor 
   - Positioned at (45, 15) offset from fountain to avoid overlap

4. ✅ FIXED: If walls are present, reduce tree density inside walls
   - Added "walled" modifier with interior tree clearing (noise_patch with 0.7 threshold)
   - Applies to walled villages only, reducing density by 0.15

5. ✅ FIXED: Add noise to tile colors for variety/texture
   - Added scattered dirt patches via noise_patch (threshold 0.78)
   - Applied to grass areas for visual texture variety

6. ✅ FIXED: Building plot overlap
   - Increased scatter_sites spacing from 12 to 15 tiles (center-to-center)
   - Ensures no overlap for buildings up to 7×7 tiles

7. ✅ FIXED: Gates don't follow wall inset
   - Added gate inset logic in server.ts applyTweaks
   - Gates now move with walls when wall_inset is adjusted
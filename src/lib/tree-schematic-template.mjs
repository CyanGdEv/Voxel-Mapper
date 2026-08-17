/**
 * Normalized geometry extracted from the user-supplied Sponge schematic
 * `31060.schem.gz` (Schematic v2, 5 x 24 x 5, source name "Tall Tree").
 *
 * The source schematic uses state-heavy Java blocks for branch detailing.
 * Voxel Mapper stores renderer-neutral wood/leaf cells here so the exact
 * silhouette can be reused safely by the Bedrock writer. Runtime renderers
 * choose their already-supported wood/leaf blocks.
 */
export const TREE_SCHEMATIC_TEMPLATE = Object.freeze({
  schemaVersion: 1,
  name: "Tall Tree",
  sourceFormat: "Sponge schematic v2",
  sourceDimensions: Object.freeze({ width: 5, height: 24, length: 5 }),
  anchor: Object.freeze({ x: 0, z: 0, groundLayer: 0 }),
  voxelCount: 173,
  voxels: Object.freeze([
  [-1,1,-1,"wood"], [0,1,-1,"wood"], [1,1,-1,"wood"], [-1,1,0,"wood"], [0,1,0,"wood"], [1,1,0,"wood"], [-1,1,1,"wood"], [0,1,1,"wood"], [1,1,1,"wood"], [-1,2,-1,"wood"], [-1,2,0,"wood"], [0,2,0,"wood"],
  [1,2,0,"wood"], [-1,2,1,"wood"], [0,2,1,"wood"], [-1,3,0,"wood"], [0,3,0,"wood"], [1,3,0,"wood"], [0,3,1,"wood"], [0,4,-1,"leaf"], [-1,4,0,"wood"], [0,4,0,"wood"], [1,4,0,"leaf"], [-1,4,1,"leaf"],
  [0,4,1,"wood"], [0,5,-2,"leaf"], [-1,5,-1,"wood"], [0,5,-1,"wood"], [1,5,-1,"leaf"], [-2,5,0,"leaf"], [-1,5,0,"wood"], [0,5,0,"wood"], [1,5,0,"leaf"], [-1,5,1,"leaf"], [0,5,1,"leaf"], [1,5,1,"leaf"],
  [-1,6,-2,"leaf"], [0,6,-2,"leaf"], [-1,6,-1,"leaf"], [0,6,-1,"leaf"], [1,6,-1,"leaf"], [-1,6,0,"leaf"], [0,6,0,"wood"], [1,6,0,"leaf"], [2,6,0,"leaf"], [-2,6,1,"leaf"], [-1,6,1,"leaf"], [0,6,1,"leaf"],
  [1,6,1,"leaf"], [2,6,1,"leaf"], [0,6,2,"leaf"], [0,7,-2,"leaf"], [-2,7,-1,"leaf"], [-1,7,-1,"wood"], [0,7,-1,"wood"], [1,7,-1,"leaf"], [-1,7,0,"leaf"], [0,7,0,"wood"], [1,7,0,"leaf"], [2,7,0,"leaf"],
  [-2,7,1,"leaf"], [-1,7,1,"leaf"], [0,7,1,"leaf"], [1,7,1,"leaf"], [2,7,1,"leaf"], [-1,7,2,"leaf"], [1,7,2,"leaf"], [-1,8,-1,"leaf"], [0,8,-1,"leaf"], [1,8,-1,"leaf"], [-2,8,0,"leaf"], [-1,8,0,"leaf"],
  [0,8,0,"wood"], [1,8,0,"wood"], [2,8,0,"leaf"], [-2,8,1,"leaf"], [-1,8,1,"leaf"], [0,8,1,"leaf"], [1,8,1,"wood"], [0,8,2,"leaf"], [1,8,2,"leaf"], [-1,9,-2,"leaf"], [0,9,-2,"leaf"], [0,9,-1,"leaf"],
  [-2,9,0,"leaf"], [-1,9,0,"leaf"], [0,9,0,"wood"], [-1,9,1,"leaf"], [0,9,1,"leaf"], [1,9,1,"leaf"], [2,9,1,"leaf"], [-1,9,2,"leaf"], [0,9,2,"leaf"], [1,9,2,"leaf"], [0,10,-2,"leaf"], [-2,10,-1,"leaf"],
  [-1,10,-1,"leaf"], [0,10,-1,"leaf"], [-1,10,0,"leaf"], [0,10,0,"wood"], [1,10,0,"leaf"], [-1,10,1,"leaf"], [0,10,1,"leaf"], [1,10,1,"leaf"], [-1,10,2,"leaf"], [1,10,2,"leaf"], [0,11,-2,"leaf"], [-1,11,-1,"leaf"],
  [0,11,-1,"leaf"], [1,11,-1,"leaf"], [-2,11,0,"leaf"], [-1,11,0,"leaf"], [0,11,0,"wood"], [1,11,0,"leaf"], [2,11,0,"leaf"], [0,11,1,"leaf"], [1,11,1,"leaf"], [0,11,2,"leaf"], [0,12,-1,"leaf"], [1,12,-1,"leaf"],
  [-2,12,0,"leaf"], [0,12,0,"wood"], [2,12,0,"leaf"], [-1,12,1,"leaf"], [0,12,1,"leaf"], [0,12,2,"leaf"], [0,13,-1,"leaf"], [-1,13,0,"leaf"], [0,13,0,"wood"], [1,13,0,"leaf"], [-1,13,1,"leaf"], [0,13,1,"leaf"],
  [1,13,1,"leaf"], [-1,14,-1,"leaf"], [0,14,-1,"leaf"], [1,14,-1,"leaf"], [0,14,0,"wood"], [1,14,0,"leaf"], [0,14,1,"leaf"], [-1,15,-1,"leaf"], [0,15,-1,"leaf"], [-1,15,0,"leaf"], [0,15,0,"wood"], [1,15,0,"leaf"],
  [-1,15,1,"leaf"], [0,15,1,"leaf"], [1,15,1,"leaf"], [0,16,-1,"leaf"], [-1,16,0,"leaf"], [0,16,0,"wood"], [1,16,0,"leaf"], [-1,16,1,"leaf"], [-1,17,-1,"leaf"], [-1,17,0,"leaf"], [0,17,0,"wood"], [1,17,0,"leaf"],
  [0,17,1,"leaf"], [-1,18,-1,"leaf"], [0,18,-1,"leaf"], [0,18,0,"wood"], [0,18,1,"leaf"], [0,19,-1,"leaf"], [-1,19,0,"leaf"], [0,19,0,"wood"], [1,19,0,"leaf"], [0,19,1,"leaf"], [0,20,0,"wood"], [1,20,0,"leaf"],
  [0,20,1,"leaf"], [0,21,0,"leaf"], [0,22,0,"leaf"], [0,23,0,"leaf"], [0,24,0,"leaf"],
  ])
});

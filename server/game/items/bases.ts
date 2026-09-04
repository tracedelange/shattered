import type { Archetype, ItemBase, Material, Range } from '../../../shared/types.ts';

function scaleRange([lo, hi]: Range, mult: number): Range {
  const slo = Math.max(1, Math.round(lo * mult));
  const shi = Math.max(slo, Math.round(hi * mult));
  return [slo, shi];
}

/**
 * Cross-product materials × archetypes into concrete item bases. A material
 * composes with an archetype only when the material's `class` is listed in the
 * archetype's `material_classes`. Stat profiles on the archetype are the
 * reference (mult 1.0); the material multipliers scale them.
 * See docs/plan-affix-brand-procgen.md.
 */
export function composeBases(materials: Material[], archetypes: Archetype[]): ItemBase[] {
  const out: ItemBase[] = [];
  for (const arch of archetypes) {
    const isArmor = arch.tags.includes('armor');
    for (const mat of materials) {
      if (!arch.material_classes.includes(mat.class)) continue;
      const tags = [...arch.tags];
      if (isArmor && mat.armor_tag) tags.push(mat.armor_tag);
      const base: ItemBase = {
        id: `${mat.id}_${arch.id}`,
        name: `${mat.name} ${arch.name}`,
        slot: arch.slot,
        tags,
        sprite: arch.sprite,
        min_ilvl: mat.min_ilvl,
        sell_value: Math.max(1, Math.round((arch.base_value ?? 1) * (mat.value_mult ?? 1))),
      };
      if (arch.base_damage) base.base_damage = scaleRange(arch.base_damage, mat.dmg_mult ?? 1);
      if (arch.base_defense) base.base_defense = scaleRange(arch.base_defense, mat.def_mult ?? 1);
      if (arch.base_speed != null) base.base_speed = arch.base_speed;
      // The attack is a property of the weapon's shape, not its material — an
      // oak staff and a yew staff both fire the same bolt, so no mult applies.
      if (arch.attack_ability) base.attack_ability = arch.attack_ability;
      if (arch.scaling) base.scaling = { ...arch.scaling };
      out.push(base);
    }
  }
  return out;
}

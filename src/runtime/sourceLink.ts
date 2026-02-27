const SOURCE_LINK_RANGE = 2;

export function getSourceAdjacentLinks(source: Source): StructureLink[] {
  return source.pos.findInRange(FIND_MY_STRUCTURES, SOURCE_LINK_RANGE, {
    filter: (structure) => structure.structureType === STRUCTURE_LINK,
  }) as StructureLink[];
}

export function getSourceAdjacentLink(source: Source): StructureLink | null {
  const links = getSourceAdjacentLinks(source);
  if (links.length === 0) {
    return null;
  }

  return source.pos.findClosestByRange(links) as StructureLink | null;
}

export function hasSourceAdjacentLink(source: Source): boolean {
  return getSourceAdjacentLinks(source).length > 0;
}

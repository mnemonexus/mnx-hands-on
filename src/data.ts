/** Reading the catalogue from the pack's assets. */
import type { ExperienceHost } from '@mnemonexus/addon-sdk';
import type { PracticeCatalogue } from '@mnemonexus/addon-sdk/practice';
import type { CatalogueEntry } from './types';

export async function loadCatalogue(host: ExperienceHost): Promise<CatalogueEntry[]> {
  const catalogue = JSON.parse(new TextDecoder().decode(await host.asset('assets/practice/catalogue.json'))) as PracticeCatalogue;
  return catalogue.activities as CatalogueEntry[];
}

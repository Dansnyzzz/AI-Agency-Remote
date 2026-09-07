import { t } from './i18n.js';

/**
 * The small formatters more than one screen needs.
 *
 * Each of these existed in several files at once — `humanSize` in five,
 * `readAsBase64` and `counted` in two apiece — and the copies had begun to
 * drift, which is the cost that makes duplication worth removing rather than
 * the duplication itself.
 */

/**
 * Bytes as something a person reads.
 *
 * This is `workspace.js`'s version, which was the outlier and the better one.
 * The four identical copies elsewhere returned `Math.max(1, …)` KB for
 * everything below a megabyte, so a 40-byte file read as "1 KB", and they
 * returned "NaN KB" for a null size rather than nothing at all.
 *
 * So unifying them does change what is shown in those four places: small files
 * now say "512 B" instead of "1 KB", and a missing size shows nothing instead
 * of NaN. Both are the answer the old code was trying to give.
 */
export const humanSize = (bytes) =>
  bytes == null
    ? ''
    : bytes >= 1024 * 1024
      ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
      : bytes >= 1024
        ? `${Math.round(bytes / 1024)} KB`
        : `${bytes} B`;

/**
 * A count and its noun, as one translated phrase.
 *
 * Not `${n} ${one}${n === 1 ? '' : 's'}`: that bakes an English pluralisation
 * rule into the formatter, and Vietnamese does not inflect the noun at all. The
 * translation owns the whole phrase and this only chooses which of the two to
 * ask for.
 */
export const counted = (n, key) => (n === 1 ? t(`${key}One`) : t(key)).replace('{n}', String(n));

/** A File as base64, without the `data:…;base64,` preamble the server does not want. */
export function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.readAsDataURL(file);
  });
}

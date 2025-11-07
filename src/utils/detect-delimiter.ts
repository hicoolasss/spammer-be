import { promises as fs } from 'fs';

export async function detectDelimiter(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath, 'utf8');
  const firstLine = content.split(/\r?\n/).find(l => l.trim().length > 0) ?? '';

  const commaCount = (firstLine.match(/,/g) || []).length;
  const semiCount  = (firstLine.match(/;/g) || []).length;

  if (semiCount > commaCount) return ';';
  return ',';
}
import { messages } from '../messages'

// One labelled figure of a candidate's result or of the Device section.
export interface Row {
  id: string
  label: string
  value: string
}

// One result the page shows: its name, then its figures, or why it failed and
// whether it ran at all.
export interface Result {
  name: string
  rows: Row[]
  failure?: { ran: boolean; reason: string }
}

// The plain text the Copy results button puts on the clipboard. It is built
// from the rows the page renders, so the values are the ones shown. Blocks are
// separated by a blank line: the Device section, then one per result.
export function resultsText(device: Row[] | undefined, results: Result[]): string {
  const line = ({ label, value }: Row) => messages.copiedRow(label, value)
  const blocks: string[][] = []
  if (device) blocks.push([messages.deviceTitle, ...device.map(line)])
  for (const { name, rows, failure } of results) {
    blocks.push([name, ...(failure ? [...(failure.ran ? [] : [messages.notRun]), failure.reason] : rows.map(line))])
  }
  return blocks.map((block) => block.join('\n')).join('\n\n')
}

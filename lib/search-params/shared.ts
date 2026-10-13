import { createParser, parseAsString, type Options } from "nuqs/server"

export const serverRoundTrip = {
  shallow: false,
  history: "push",
} satisfies Options

export const parseAsPage = createParser({
  parse: (value) => {
    const parsed = parseInt(value, 10)
    return Number.isNaN(parsed) ? 1 : Math.max(1, parsed)
  },
  serialize: (value) => String(value),
})
  .withDefault(1)
  .withOptions(serverRoundTrip)

export const parseAsFilter = parseAsString
  .withDefault("")
  .withOptions(serverRoundTrip)

export const tablePendingClass = (pending: boolean) =>
  pending ? "opacity-50 transition-opacity" : "transition-opacity"

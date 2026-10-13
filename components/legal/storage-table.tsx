import { STORAGE_INVENTORY } from "@/lib/legal/storage-inventory"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

export function StorageTable() {
  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Art</TableHead>
            <TableHead>Zweck</TableHead>
            <TableHead>Speicherdauer</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {STORAGE_INVENTORY.map((entry) => (
            <TableRow key={entry.names.join(",")}>
              <TableCell className="align-top">
                {entry.names.map((name) => (
                  <code key={name} className="block font-mono text-xs">
                    {name}
                  </code>
                ))}
              </TableCell>
              <TableCell className="align-top">{entry.kind}</TableCell>
              <TableCell className="min-w-56 align-top whitespace-normal">
                {entry.purpose}
              </TableCell>
              <TableCell className="min-w-36 align-top whitespace-normal">
                {entry.duration}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

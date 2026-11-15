import { CONSTITUENTS_AS_OF, type IndexConstituent } from "@/lib/index-constituents";
import { DataTable, Panel, Td } from "./ui";

const snapshotDate = new Intl.DateTimeFormat("en-IN", {
  timeZone: "UTC",
  dateStyle: "medium",
}).format(new Date(`${CONSTITUENTS_AS_OF}T00:00:00Z`));

export function ConstituentsPanel({
  name,
  rows,
}: {
  name: string;
  rows: readonly IndexConstituent[];
}) {
  const largest = Math.max(...rows.map((row) => row.mcapShare));

  return (
    <Panel
      title={`${name} constituents`}
      meta={`${rows.length} stocks · snapshot ${snapshotDate} from dhan.co`}
      flush
    >
      <DataTable
        caption={`${name} constituents`}
        minWidth="min-w-[44rem]"
        columns={[
          { label: "#", align: "right", className: "w-10" },
          { label: "Symbol", align: "left" },
          { label: "Company", align: "left" },
          { label: "Sector", align: "left" },
          { label: "Mcap share", align: "right" },
        ]}
      >
        {rows.map((row, index) => (
          <tr key={row.symbol}>
            <Td numeric className="text-label text-muted">
              {index + 1}
            </Td>
            <Td className="font-medium">{row.symbol}</Td>
            <Td className="text-muted">{row.name}</Td>
            <Td className="text-muted">{row.sector}</Td>
            <Td numeric>
              <span className="flex items-center justify-end gap-2">
                <span aria-hidden className="h-1.5 w-24 overflow-hidden rounded-sm bg-raised sm:w-32">
                  <span
                    className="block h-full bg-accent/70"
                    style={{ width: `${(row.mcapShare / largest) * 100}%` }}
                  />
                </span>
                <span className="w-14">{row.mcapShare.toFixed(2)}%</span>
              </span>
            </Td>
          </tr>
        ))}
      </DataTable>
      <p className="border-t border-line px-3 py-2 text-label text-muted">
        Mcap share is each stock&apos;s share of the index&apos;s combined full market cap, the way
        dhan.co computes it. NSE and BSE weight indices by free-float market cap, so official weights
        differ, most for companies with large promoter or government holdings such as LIC, SBI and
        Reliance.
      </p>
    </Panel>
  );
}

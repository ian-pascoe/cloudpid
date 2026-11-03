// Who sent an owner's message over the MCP endpoint (`docs/architecture/mcp-endpoint.md` → Access and identity, Marks): a
// chip under the message, "via pi (MCP)". The client's name is the caller's own word, shown as text; the owner's email and
// the grant behind the input are never shown.
import { inputViaLabel, type SessionVia } from "@cloudpid/protocol";

export const ViaChip = ({ via }: { via: SessionVia }) => (
  <p className="mt-1.5 w-fit rounded-full border bg-background px-2 py-0.5 text-xs text-muted-foreground">
    {inputViaLabel(via)}
  </p>
);

// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- JSX lists are native arrays.

// The "Sign-in (OAuth)" disclosure of the MCP server form (docs/architecture/mcp-sign-in.md → Settings, The `oauth` fields;
// docs/architecture/mcp-configuration.md → The Settings page's "MCP servers" section): `clientId`, `clientSecret` and
// `privateKey` as `${NAME}`, `keyId`, `scope`, `clientName`, `clientRegistration`, `authServerMetadataUrl`, `issuer` and
// `grantType`; beside them the stage's redirect URI and the client name that will actually be registered, each with Copy.
// Never a secret's value: the two secret fields hold a `${NAME}` that the Scope's Secrets or Variables resolve.

import { useAtomValue } from "@effect/atom-react";
import { type ReactNode, useState } from "react";
import { Input } from "../components/ui/input.tsx";
import {
  MCP_CLIENT_REGISTRATIONS,
  MCP_GRANT_TYPES,
  type McpClientRegistration,
  type McpGrantType,
  type McpOauthFields,
  type McpOauthTextKey,
} from "./mcp-form.ts";
import { mcpSignInNames } from "./mcp-sign-in-model.ts";
import { mcpSignInsStateAtom } from "./mcp-sign-in-state.ts";
import { OptionSelect } from "./mcp-parts.tsx";
import { CopyValue, Field, noteId } from "./parts.tsx";

const REGISTRATION_LABELS: Readonly<Record<McpClientRegistration, string>> = {
  auto: "Automatic",
  cimd: "Client document",
  dcr: "Dynamic registration (DCR)",
};

const GRANT_LABELS: Readonly<Record<McpGrantType, string>> = {
  authorization_code: "You sign in (authorization code)",
  client_credentials: "It signs in on its own (client credentials)",
};

/** The disclosure: every field of `oauth` the form edits, and the redirect URI and client name beside them. */
export const OauthDisclosure = ({
  scope,
  oauth,
  namesList,
  referenceHint,
  ignored,
  onChange,
}: {
  scope: string;
  oauth: McpOauthFields;
  /** The id of the datalist of `${NAME}` the secret fields suggest. */
  namesList: string;
  /** What a `${NAME}` may name at the Scope (the names, never a value). */
  referenceHint: ReactNode;
  /** The `oauth` keys the form keeps and cloudpid ignores (`callbackPort`, `callbackUrl`). */
  ignored: ReadonlyArray<string>;
  onChange: (next: Partial<McpOauthFields>) => void;
}) => {
  const state = useAtomValue(mcpSignInsStateAtom);
  const stage = state.status === "ready" ? state.list.stage : undefined;
  const pageOrigin = typeof window === "undefined" ? undefined : window.location.origin;
  const names = mcpSignInNames(stage, pageOrigin, oauth);
  const grant = oauth.grantType === "client_credentials";
  const id = (field: string) => `mcp-oauth-${field}-${scope}`;

  const text = (
    key: McpOauthTextKey,
    label: string,
    options: {
      readonly hint?: ReactNode;
      readonly placeholder?: string;
      readonly reference?: boolean;
    } = {},
  ) => (
    <Field label={label} htmlFor={id(key)} hint={options.hint}>
      <Input
        id={id(key)}
        aria-describedby={options.hint === undefined ? undefined : noteId(id(key))}
        value={oauth[key]}
        placeholder={options.placeholder}
        list={options.reference === true ? namesList : undefined}
        spellCheck={false}
        autoComplete="off"
        data-1p-ignore
        className="font-mono"
        onChange={(event) => {
          onChange({ [key]: event.target.value });
        }}
      />
    </Field>
  );

  const touched =
    oauth.clientId !== "" ||
    oauth.clientSecret !== "" ||
    oauth.privateKey !== "" ||
    oauth.keyId !== "" ||
    oauth.scope !== "" ||
    oauth.clientName !== "" ||
    oauth.authServerMetadataUrl !== "" ||
    oauth.issuer !== "" ||
    oauth.clientRegistration !== "auto" ||
    grant;

  // Open on first sight when the entry already has something to show; after that the owner's own opening and closing stand,
  // so typing the first character into a closed disclosure does not shut it under the owner's hands.
  const [openAtStart] = useState(touched);

  return (
    <details className="rounded-lg border" open={openAtStart}>
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium">Sign-in (OAuth)</summary>
      <div className="flex flex-col gap-4 border-t p-4">
        <p className="max-w-prose text-xs text-muted-foreground">
          Most servers need none of this: cloudpid signs in with its own client and registers
          itself. Fill it in to use a client you registered, to pin the authorization server, or to
          sign in with client credentials. Secrets are written as <code>{"${NAME}"}</code>, never as
          the value.
        </p>
        <Field label="Sign-in kind" htmlFor={id("grantType")}>
          <OptionSelect
            id={id("grantType")}
            options={MCP_GRANT_TYPES}
            labels={GRANT_LABELS}
            value={oauth.grantType}
            onChange={(grantType) => {
              onChange({ grantType });
            }}
          />
        </Field>
        {text("clientId", "Client id", {
          hint: grant
            ? "The client the authorization server knows, for client credentials."
            : "A client you registered by hand, where the server offers neither dynamic registration nor a client document (GitHub).",
          placeholder: "my-client-id",
        })}
        {text("clientSecret", "Client secret", {
          hint: (
            <>
              Exactly one <code>{"${NAME}"}</code>: a Secret (or a Variable), never the value.{" "}
              {referenceHint}
            </>
          ),
          placeholder: "${CLIENT_SECRET}",
          reference: true,
        })}
        {grant &&
          text("privateKey", "Private key", {
            hint: (
              <>
                A <code>{"${NAME}"}</code> holding a PKCS#8 PEM, instead of a client secret (RFC
                7523). {referenceHint}
              </>
            ),
            placeholder: "${CLIENT_KEY}",
            reference: true,
          })}
        {grant && text("keyId", "Key id", { hint: "The key's id, sent as the assertion's kid." })}
        {text("scope", "Scope", {
          hint: "Space-separated. What the server asks for is added to it.",
          placeholder: "read write",
        })}
        {text("issuer", "Issuer", {
          hint: grant
            ? "Pins the authorization server (https, no query). Needed for client credentials unless a metadata URL is given."
            : "Pins the authorization server: a different issuer is refused.",
          placeholder: "https://auth.example.com",
        })}
        {text("authServerMetadataUrl", "Authorization server metadata URL", {
          hint: "Pins the authorization server by its metadata document (https).",
          placeholder: "https://auth.example.com/.well-known/oauth-authorization-server",
        })}
        {!grant && (
          <>
            {text("clientName", "Client name", {
              hint: "What the authorization server shows for cloudpid, when cloudpid registers itself (dynamic registration). A non-prod stage adds its label.",
              placeholder: "cloudpid",
            })}
            <Field
              label="Client registration"
              htmlFor={id("clientRegistration")}
              hint="Automatic uses your client id, else the client document, else dynamic registration. Choose DCR when an authorization server refuses the document."
            >
              <OptionSelect
                id={id("clientRegistration")}
                options={MCP_CLIENT_REGISTRATIONS}
                labels={REGISTRATION_LABELS}
                value={oauth.clientRegistration}
                describedBy={noteId(id("clientRegistration"))}
                onChange={(clientRegistration) => {
                  onChange({ clientRegistration });
                }}
              />
            </Field>
          </>
        )}
        {grant ? (
          <p className="max-w-prose text-xs text-muted-foreground">
            It signs in on its own: cloudpid fetches a token when it needs one, with no sign-in
            page, so there is no redirect URI to register and no client name.
          </p>
        ) : (
          <div className="flex flex-col gap-3 rounded-md border border-dashed p-3">
            {names.redirectUri === null ? (
              <p className="text-xs text-muted-foreground">
                The redirect URI is shown once the stage's origin is known.
              </p>
            ) : (
              <CopyValue
                label="Redirect URI"
                value={names.redirectUri}
                hint="Register this where you create a client by hand. An authorization server that does not say which issuer answered gets the same address with a short issuer hash after it."
              />
            )}
            {names.clientName === null ? (
              <p className="text-xs text-muted-foreground">
                No client name is sent while a client id is set.
              </p>
            ) : (
              <CopyValue
                label="Client name"
                value={names.clientName}
                hint="What this stage registers as, and shows on the authorization server's page."
              />
            )}
          </div>
        )}
        {ignored.length > 0 && (
          <p className="max-w-prose text-xs text-muted-foreground">
            {ignored.join(" and ")} {ignored.length === 1 ? "is" : "are"} accepted and ignored:
            cloudpid signs in at its own redirect URI
            {names.redirectUri === null ? "" : `, ${names.redirectUri}`}.
          </p>
        )}
      </div>
    </details>
  );
};

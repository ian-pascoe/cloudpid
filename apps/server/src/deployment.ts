/** The one person allowed through Access: the owner of this single-user deployment. */
export const OWNER_EMAIL = "ian.g.pascoe@gmail.com";

/** The custom domain of the `prod` stage, on the `ianpascoe.dev` zone of the same account. */
export const PRODUCTION_DOMAIN = "pi.ianpascoe.dev";

/**
 * Where a stage's main Worker is served and who may reach it. `prod` answers on its custom
 * domain; every other stage (`dev_$USER`, previews) stays on `workers.dev`. The Worker's Access
 * application covers all of its URLs, so every stage admits only {@link OWNER_EMAIL}.
 */
export const deployment = (stage: string) => {
  const access = {
    policies: [{ decision: "allow" as const, include: [{ email: OWNER_EMAIL }] }],
  };

  return stage === "prod"
    ? { domain: PRODUCTION_DOMAIN, workersDev: false, access }
    : { workersDev: true, access };
};

import type { Metadata } from "next";
import { ArrowLeft } from "react-bootstrap-icons";
import { ClaimFlow } from "@/components/manage/ClaimFlow.tsx";
import {
  claimViaDiscord,
  discoverSystems,
  startChallenge,
  verifyChallenge,
} from "../actions.ts";

export const metadata: Metadata = { title: "Claim a system" };

/**
 * Discovery runs on load so the common case — your Discord account is linked to
 * your system — is already answered by the time the page appears, rather than
 * hiding behind a button.
 */
export default async function ClaimPage() {
  const discovered = await discoverSystems();

  async function discover() {
    "use server";
    return discoverSystems();
  }
  async function claim(ref: string) {
    "use server";
    return claimViaDiscord(ref);
  }
  async function begin(ref: string) {
    "use server";
    return startChallenge(ref);
  }
  async function verify(id: string) {
    "use server";
    return verifyChallenge(id);
  }

  return (
    <div className="mg-shell" style={{ maxWidth: "46rem" }}>
      <p style={{ marginTop: 0 }}>
        <a className="btn" href="/manage">
          <ArrowLeft aria-hidden="true" /> Your systems
        </a>
      </p>

      <div className="mg-head">
        <h1>Claim a system</h1>
        <p>
          Claiming lets you manage how a system appears on the web. It does not
          change anything in PluralKit.
        </p>
      </div>

      <ClaimFlow
        actions={{
          discover,
          claim,
          startChallenge: begin,
          verifyChallenge: verify,
        }}
        initialSystems={discovered.ok ? discovered.systems : []}
        initialError={discovered.ok ? null : discovered.error}
      />
    </div>
  );
}

# Legal Notice & Acceptable Use

Fusill is a **security testing tool** intended for authorized resilience testing
of infrastructure you own or are explicitly permitted to test. Read this before
using, running a node, or deploying the software.

## Authorized use only

You may use Fusill **only** against:

- infrastructure you own, or
- infrastructure you have **explicit, written authorization** from the owner to
  test.

Running load or denial-of-service tests against systems without authorization is
illegal in most jurisdictions (e.g. the Computer Fraud and Abuse Act in the US,
the Computer Misuse Act in the UK, and equivalent laws elsewhere) and may carry
civil and criminal penalties.

## Built-in safeguard — and its limits

The protocol includes a technical control: every node independently verifies
that the job creator controls the target before sending any traffic (see
[`docs/ownership-verification.md`](./docs/ownership-verification.md)). This is
designed to prevent the network from being pointed at third parties.

This safeguard is a deterrent, **not a guarantee**. It does not remove your legal
obligation to obtain authorization, and it cannot prevent a determined operator
from misusing a self-hosted copy of the software.

## No warranty, no liability

The software is provided "AS IS", without warranty of any kind, as stated in the
[LICENSE](./LICENSE).

To the maximum extent permitted by law, the authors and contributors **accept no
responsibility or liability** for any use or misuse of this software, including
but not limited to unauthorized testing, service disruption, data loss, or any
direct, indirect, incidental, or consequential damages arising from its use. Use
of Fusill is entirely at your own risk, and **you are solely responsible** for
ensuring your use complies with all applicable laws and that you have the
necessary authorization for any test you run.

By using, running, or deploying Fusill — or any node on the network — you
acknowledge that you have read and agree to this notice.

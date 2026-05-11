# Disclaimer

This document expands the warranty-and-liability language in the
[LICENSE](./LICENSE) file in plain English, so users and operators of
**Ditto Edge Studio** know what they're getting before they install it.

## Provided "as is"

The software, its source code, its documentation, and every artifact
distributed alongside it (the "Software") is provided to you **"as is"** —
in whatever state it is in at the moment you download, install, or use
it. No promises are made about its current quality, its future quality,
or its suitability for any purpose, whether that purpose is stated or
implied.

You use the Software at your own risk. You are solely responsible for
evaluating whether it is appropriate for what you want to do with it.

## No warranty

To the maximum extent allowed by applicable law, the authors and
copyright holders **disclaim every warranty**, express or implied,
including but not limited to:

- the implied warranty of **merchantability** (that the Software is fit
  to be sold or generally useful),
- the implied warranty of **fitness for a particular purpose** (that it
  works for whatever specific job you have in mind),
- the implied warranty of **non-infringement** (that using the Software
  does not infringe anyone else's rights),
- any warranty of **accuracy**, **reliability**, **timeliness**,
  **completeness**, **security**, or **uninterrupted operation**.

This includes — but is not limited to — features such as connection
management, query execution, presence visualisation, data import and
export, metrics, attachments, and any integration with Ditto Cloud,
Ditto Server, or third-party services.

## No support obligation

Nothing in this Disclaimer, the LICENSE file, or the Software itself
creates an obligation on anyone to:

- respond to bug reports or feature requests,
- ship fixes within any particular timeframe (or at all),
- maintain backwards compatibility between versions,
- provide installation, configuration, training, or operational
  support.

Community channels and issue trackers may exist, but engagement on
them is voluntary and at the discretion of the maintainers.

## No data guarantees

Ditto Edge Studio is a tooling layer that reads from and writes to
your Ditto databases. It can run arbitrary DQL statements that you
type, import documents into collections, delete documents, and modify
schema-relevant configuration. **You are responsible for what you do
with it.** The maintainers make no promises that:

- imports, exports, deletions, or schema changes you initiate will
  succeed, partially succeed, or be reversible,
- data shown in the UI is current, complete, or accurate at the
  moment you look at it,
- destructive operations (DELETE statements, drop-table-like flows,
  attachment deletion) will preserve any backup or recovery copy,
- the Software will detect or prevent operations that could result in
  data loss, data corruption, exposure of secrets, or breach of any
  policy you may be subject to (regulatory, contractual, internal, or
  otherwise).

Back up your data. Test destructive operations against non-production
systems first.

## No liability

To the maximum extent allowed by applicable law, the authors and
copyright holders are **not liable for any damages** arising out of or
in connection with the Software or its use, including (without
limitation):

- direct, indirect, incidental, special, exemplary, consequential, or
  punitive damages,
- loss of profits, loss of revenue, loss of business opportunity,
- loss of data, corruption of data, leakage of data, or any cost of
  recovering or recreating data,
- downtime, interruption of service, or failure to meet any SLA,
- damages caused by relying on information shown in the UI or written
  to logs,

regardless of the legal theory under which liability is asserted
(contract, tort, negligence, strict liability, or otherwise) and even
if the maintainers have been advised of the possibility of such
damages.

## Third-party services

Ditto Edge Studio interacts with the Ditto SDK and may reach out over
the network to Ditto Cloud, Ditto Server deployments you point it at,
and other services. The Software is **not affiliated with, endorsed
by, or controlled by** any service it integrates with, except where
explicitly stated. Use of those services is governed by their own
terms, and the authors of this Software accept no responsibility for
their availability, behaviour, billing, or policies.

## No legal advice

This Disclaimer is informational and is not legal advice. The
binding terms of use are those set out in the
[LICENSE](./LICENSE) file. If there is any conflict between this
document and the LICENSE, **the LICENSE governs**.

If the Software's terms are not acceptable to you, you may not use
the Software.

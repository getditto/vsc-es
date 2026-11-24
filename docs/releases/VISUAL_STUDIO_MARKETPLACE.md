# Publishing to Visual Studio Marketplace

The [Publish to Visual Studio Marketplace workflow](../../.github/workflows/publish-visual-studio-marketplace.yml)
verifies the four VSIX packages attached to a stable GitHub Release and uses
Trusted Publishing to upload them under `DittoLive`.

## Configure Trusted Publishing

After the workflow is on `main`, open the `DittoLive` publisher’s **Trusted
Publishing** tab and create a policy with these settings. [Publisher management](https://marketplace.visualstudio.com/manage/publishers/DittoLive)

| Field | Value |
| --- | --- |
| Policy name | Ditto Edge Studio |
| Repository owner | `getditto` |
| Repository | `vsc-es` |
| Workflow | `publish-visual-studio-marketplace.yml` |
| Environment | `visual-studio-marketplace` |

The GitHub environment allows deployments from the `main` branch. This
repository is private, so run the workflow with upload enabled within 48 hours
of creating the policy. The first successful token exchange activates it.
[Microsoft Trusted Publishing documentation](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#publish-with-github-actions-and-trusted-publishing)

## Verify and publish a release

1. In GitHub Actions, open **Publish to Visual Studio Marketplace**, select
   **Run workflow** on `main`, and enter a stable release tag such as `v0.96.1`.
2. Leave **Upload the verified packages to Visual Studio Marketplace** unchecked
   to verify the GitHub Release packages without requesting an OIDC token.
3. Run it with upload enabled when the release is ready for the Marketplace.
   The workflow skips platform packages already uploaded for that version.
4. Confirm the Marketplace lists the release with macOS arm64, Linux arm64,
   Linux x64, and Windows x64 packages.
   [Ditto Edge Studio on Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=DittoLive.ditto-vsce)

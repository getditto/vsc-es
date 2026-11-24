# Publishing to Open VSX

The [Publish to Open VSX workflow](../../.github/workflows/publish-open-vsx.yml)
uploads the four platform-specific VSIX packages from a published GitHub Release.
It checks the release tag, package digests, extension identity, version, target
platform, and included Ditto SDK binary before uploading any package.

## One-time setup

1. Sign in to Open VSX with the publisher account, connect its Eclipse account,
   and accept the Publisher Agreement. Follow the [Open VSX publishing guide](https://github.com/eclipse-openvsx/openvsx/wiki/Publishing-Extensions).
2. Create the `DittoLive` namespace if needed and make sure the publishing
   account is a member. The namespace must match `publisher` in `package.json`.
   Claim ownership of the namespace so Open VSX can verify it against the
   Visual Studio Marketplace publisher.
   [Open VSX namespace access](https://github.com/eclipse-openvsx/openvsx/wiki/Namespace-Access).
3. The workflow uses the repository's `VSX_TOKEN` GitHub Actions secret.
   The token's account needs publishing access to `DittoLive`.

## Validate and publish a release

1. In GitHub Actions, open **Publish to Open VSX** and select **Run workflow**
   on `main`. Enter the published release tag, such as `v0.96.1`.
2. Keep **Upload the verified packages to Open VSX** unchecked to validate
   the release without a publisher token.
3. Run the workflow again with upload enabled when the release is ready for
   Open VSX. If some uploads fail, rerun it with the same tag. Open VSX skips
   platform packages it already has for that version.
4. After publishing, confirm that the version offers macOS arm64, Linux arm64,
   Linux x64, and Windows x64 downloads. [Ditto Edge Studio on Open VSX](https://open-vsx.org/extension/DittoLive/ditto-vsce).

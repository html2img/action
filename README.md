# HTML to Image

Render HTML, a live URL or a named template to an image from a GitHub workflow, using the [HTML to Image API](https://html2img.com). Use it to generate Open Graph images for new posts, screenshot a pull request preview, or produce a social card when you publish a release.

A free account comes with 50 credits and needs no card. One credit is one render.

## Quick start

Create a key on your [dashboard](https://app.html2img.com/dashboard), add it to the repository as a secret named `HTML2IMG_API_KEY`, then:

```yaml
# HTML to Image API — https://html2img.com
- uses: html2img/action@v1
  with:
    api-key: ${{ secrets.HTML2IMG_API_KEY }}
    html: '<div style="font: 700 72px system-ui; padding: 80px">Hello</div>'
    width: 1200
    height: 630
    output-path: og/hello.png
```

The step writes `og/hello.png` into the workspace and sets the `url` output to the hosted render.

## Recipes

### Open Graph images for new posts

This generates a card for every post that does not have one yet, then commits the results. The example is Astro; Hugo, Eleventy and Jekyll work the same way, because only the content path changes.

Committing the images is deliberate. On the free plan renders are kept for 7 days, so a build artefact belongs in the repository or in your deploy output rather than hotlinked from the CDN.

```yaml
# HTML to Image API — https://html2img.com
name: OG images

on:
  push:
    branches: [main]
    paths: ['src/content/blog/**']

permissions:
  contents: write

jobs:
  find-posts:
    runs-on: ubuntu-latest
    outputs:
      slugs: ${{ steps.find.outputs.slugs }}
    steps:
      - uses: actions/checkout@v4

      - id: find
        name: List posts with no card yet
        run: |
          slugs=$(for file in src/content/blog/*.md; do
            slug=$(basename "$file" .md)
            if [ ! -f "public/og/$slug.png" ]; then printf '%s\n' "$slug"; fi
          done | jq -R . | jq -sc .)
          echo "slugs=$slugs" >> "$GITHUB_OUTPUT"

  render:
    needs: find-posts
    if: needs.find-posts.outputs.slugs != '[]'
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        slug: ${{ fromJSON(needs.find-posts.outputs.slugs) }}
    steps:
      - uses: actions/checkout@v4

      - name: Build the card markup
        run: |
          title=$(sed -n 's/^title: *//p' "src/content/blog/${{ matrix.slug }}.md" | head -1 | tr -d '"')
          mkdir -p build
          cat > build/card.html <<HTML
          <!doctype html>
          <meta charset="utf-8">
          <div style="display:flex;align-items:center;width:1200px;height:630px;
                      box-sizing:border-box;padding:80px;background:#0f172a;
                      color:#fff;font:700 68px/1.15 system-ui,sans-serif">
            $title
          </div>
          HTML

      - uses: html2img/action@v1
        with:
          api-key: ${{ secrets.HTML2IMG_API_KEY }}
          html-file: build/card.html
          width: 1200
          height: 630
          output-path: public/og/${{ matrix.slug }}.png

      - uses: actions/upload-artifact@v4
        with:
          name: og-${{ matrix.slug }}
          path: public/og/

  commit:
    needs: render
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/download-artifact@v4
        with:
          pattern: og-*
          merge-multiple: true
          path: public/og

      - name: Commit the cards
        run: |
          git config user.name 'github-actions[bot]'
          git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
          git add public/og
          if git diff --cached --quiet; then
            echo 'No new cards.'
          else
            git commit -m 'Add Open Graph images'
            git push
          fi
```

The `.html2img-hash` files committed alongside the images let later runs skip renders whose inputs have not changed.

### Screenshot a pull request preview

This screenshots a deployed preview and posts it as a pull request comment, updating the same comment on each push. Secrets are not available to workflows triggered by a pull request from a fork, so the job is limited to branches on this repository.

Replace the preview URL with whatever your host produces; the pattern below is Netlify's.

```yaml
# HTML to Image API — https://html2img.com
name: Preview screenshot

on:
  pull_request:

permissions:
  contents: read
  pull-requests: write

jobs:
  screenshot:
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    steps:
      - name: Wait for the preview to answer
        id: preview
        run: |
          url="https://deploy-preview-${{ github.event.pull_request.number }}--example.netlify.app"
          for _ in $(seq 1 30); do
            if curl -fsS -o /dev/null "$url"; then
              echo "url=$url" >> "$GITHUB_OUTPUT"
              exit 0
            fi
            sleep 10
          done
          echo "The preview at $url did not answer within five minutes." >&2
          exit 1

      - uses: html2img/action@v1
        id: shot
        with:
          api-key: ${{ secrets.HTML2IMG_API_KEY }}
          url: ${{ steps.preview.outputs.url }}
          width: 1280
          height: 800

      - uses: peter-evans/create-or-update-comment@v4
        with:
          issue-number: ${{ github.event.pull_request.number }}
          body: |
            Preview of ${{ github.event.pull_request.head.sha }}:

            ![Preview screenshot](${{ steps.shot.outputs.url }})
```

No `output-path` is set here, so nothing is written to the workspace and the comment points at the hosted render. On the free plan that image disappears after 7 days, which is usually longer than the pull request stays open.

### Social card on release

This renders a card from a named template when you publish a release, then attaches it to the release. See the full list of [templates](https://html2img.com/templates) and the inputs each one takes.

```yaml
# HTML to Image API — https://html2img.com
name: Release card

on:
  release:
    types: [published]

permissions:
  contents: write

jobs:
  card:
    runs-on: ubuntu-latest
    steps:
      # Built with jq rather than interpolated into the JSON directly, so a
      # release name containing a quote cannot break the payload.
      - name: Build the template variables
        id: vars
        env:
          TITLE: ${{ github.event.release.name || github.event.release.tag_name }}
          SUBTITLE: ${{ github.repository }} ${{ github.event.release.tag_name }}
        run: |
          json=$(jq -nc --arg title "$TITLE" --arg subtitle "$SUBTITLE" \
            '{title: $title, subtitle: $subtitle,
              background_color: "#0f172a", accent_color: "#3b82f6"}')
          echo "json=$json" >> "$GITHUB_OUTPUT"

      - uses: html2img/action@v1
        id: card
        with:
          api-key: ${{ secrets.HTML2IMG_API_KEY }}
          template: open-graph-image
          variables: ${{ steps.vars.outputs.json }}
          output-path: release-card.png

      - name: Attach the card to the release
        env:
          GH_TOKEN: ${{ github.token }}
        run: gh release upload '${{ github.event.release.tag_name }}' release-card.png --repo '${{ github.repository }}'
```

A template renders at its own size, so `width` and `height` are not set here.

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `api-key` | yes | | Your API key. Store it as a repository secret; it is masked in the logs. |
| `html` | one source | | Inline HTML document to render. |
| `html-file` | one source | | Path to an HTML file in the workspace to render. |
| `url` | one source | | Publicly reachable URL to screenshot. |
| `template` | one source | | Slug of a named template, for example `open-graph-image`. |
| `variables` | no | | JSON object of the template inputs. Only valid alongside `template`. |
| `width` | no | `1440` | Viewport width in pixels, 1 to 5000. |
| `height` | no | `900` | Viewport height in pixels, 1 to 5000. |
| `format` | no | `png` | Either `png` or `pdf`. |
| `output-path` | no | | Path to download the render to. Parent directories are created. |
| `skip-unchanged` | no | `true` | Skip the API call when the output and its hash sidecar are already current. |

Set exactly one of `html`, `html-file`, `url` or `template`. The defaults for `width`, `height` and `format` are the API's own: leave them out and the API applies them.

`width` and `height` are ignored for a template, which renders at its own size, and for `format: pdf`, which is A4 portrait. The action warns rather than failing if you set them anyway.

## Outputs

| Output | Description |
| --- | --- |
| `url` | The hosted URL of the render. On a skip, the URL recorded in the sidecar. |
| `path` | The path the render was downloaded to, or empty when `output-path` was not set. |
| `skipped` | `true` when the render was skipped because the inputs had not changed. |

## Credits and caching

One credit is one render, whether the output is a PNG or a PDF. Nothing in this action retries, so a failed render does not spend a credit twice.

With `output-path` set and `skip-unchanged` left on, the action hashes the resolved inputs — the markup or URL, the template and its variables, and the dimensions and format — and writes the digest next to the file as `<output-path>.html2img-hash`. When the file and a matching digest are both present, the API is never called and `skipped` is `true`. Commit both files to keep that cache across runs. The API key is not part of the digest, so rotating a key does not invalidate anything.

Renders on the free plan are kept for 7 days. Paid plans keep them indefinitely; see [pricing](https://html2img.com/pricing).

## Errors

Failures name the cause and the fix. An invalid key says so and points at the dashboard; running out of credits says so and points at pricing; a rejected parameter is reported with the API's own message for that field. Neither the key nor the rendered HTML is written to the log.

## Notes

The action runs on the node20 runner with no container, so it adds no pull to your job. `dist/` is committed because the runner executes it directly.

Full parameter reference and language examples are in [the docs](https://html2img.com/docs).

## Licence

MIT. Built on the [HTML to Image API](https://html2img.com).

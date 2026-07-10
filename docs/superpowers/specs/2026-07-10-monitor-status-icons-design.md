# Monitor Status Icons Design

## Goal

Make the current state of every monitored service immediately visible by showing a colored line icon before its name.

## Scope

- Keep the existing status model unchanged: operational, unavailable, and no data.
- Render the icon in the existing service-name row, before the name and optional external link.
- Do not add status text badges, error-reason copy, status-icon tooltips, or monitoring API fields; retain the existing service-description tooltip.

## Visual behavior

| Service state | Icon | Color |
| --- | --- | --- |
| Operational | Existing check-in-circle icon | `--green` |
| Unavailable | Existing alert-in-circle icon | `--red` |
| No data | Existing check-in-circle icon | neutral `--gray` |

The status icon remains visible whether the service name is a link or plain text. Existing service cards, uptime bars, latency charts, and grouped-monitor summaries remain unchanged.

## Implementation boundary

Update only the browser-side monitor renderer and its localization entries if a fallback label is needed. No Worker, D1, monitor, API, or configuration changes are required.

## Verification

- Add focused tests for status-icon selection if the renderer is made importable without changing its browser behavior.
- Run the existing test suite and TypeScript check.
- Inspect the status-page markup for each of the three states.

# Instagram Contact Messenger/Mass Messeger

A local Chrome/Edge Manifest V3 extension that lets you select accounts from Instagram's **Following** dialog, enter one message, and send it sequentially to the selected accounts.

> Instagram does not provide an official API for initiating arbitrary DMs. This extension automates the website UI, which can stop working when Instagram changes its interface and may lead to action restrictions. Use a small recipient list and stop if Instagram displays a warning or checkpoint.

## Install

1. Open `chrome://extensions` in Chrome, or `edge://extensions` in Edge.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Choose this project folder.
5. Sign in to `https://www.instagram.com/` normally. The extension never asks for or stores your password.

## Use

1. Open Instagram and navigate to your profile.
2. Click the extension icon to open the side panel.
3. Open your **Following** list.
4. In the side panel, click **Enable** under recipient selection.
5. Tick the injected checkbox beside each person's existing **Following** button.
6. Enter the shared message, review the selected accounts, check the confirmation, and click **Send to selected**.
7. Keep the side panel open while the queue runs. It records each recipient as sent or failed.

The current control matching expects Instagram's interface language to be English.

## Safety and limits

- Sends are sequential, with an eight-second pause between attempts.
- Recipient state is persisted, so queues of 100+ accounts remain available until cleared.
- The queue stops when a login prompt, verification checkpoint, or activity restriction is detected.
- Recipient data, message text, and results are stored only in `chrome.storage.local`.
- The extension opens inactive Instagram tabs during processing and closes each one afterward.
- Closing the side panel stops the active JavaScript queue; reopen it to inspect saved results.

## Troubleshooting

- If selection buttons do not appear, reload Instagram after installing or updating the extension, then reopen the Following dialog.
- If every send fails, Instagram likely changed its page controls. Inspect the failed status tooltip and update the selectors in `content-script.js`.
- A `sent` result means the extension clicked Instagram's enabled Send control. Instagram does not expose delivery confirmation to this extension.

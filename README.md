# Hands On (MnemoNexus add-on engine)

Learn by doing. Move a curve, place the bands on a gel, knock out part of a pathway, choose the controls, read a spectrum, find the
error or sort the ideas. You commit to a guess first, then see the real result beside it.

The engine is general: it has no subject in it. Each activity family (dial, grow, network, construct, controls, spectrum, sort, spot)
reads its activities from JSON files, so the same engine serves any subject and a new topic is a data file, not code.

## What is, and is not, in this repository

This repository is the **engine and its tests**. It does **not** include any practice content: the activities that
drive it were written from university course material (lecture slides, worksheets and past papers), which is not ours
to publish, so `content/` is deliberately empty. Without content the add-on shows nothing to practise, and
tests that load content will not pass. To use the engine, write your own activities for your own subject.

It is built with the [MnemoNexus add-on kit](https://github.com/mnemonexus/mnx-addon-kit). The scripts expect the kit
checked out as a sibling folder named `mnx-addon-kit-release`; adjust the paths in `package.json` if you keep it elsewhere.

## Licence

MIT, see [LICENSE](LICENSE).

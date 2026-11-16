# 第三方声明

## Mona Sans / Mona Sans Mono

The bundled `MonaSansVF.woff2` and `MonaSansMonoVF.woff2` fonts originate from [github/mona-sans](https://github.com/github/mona-sans) and are distributed under the SIL Open Font License 1.1. They are used only for the local UI typography.

## tomatotimer visual reference

The layout and visual measurements were adapted from `Jaxon1216/tomatotimer`, a private MIT-licensed fork of Pomotroid. No Svelte or Rust source was copied into this repository. The reference repository's MIT notice is retained here because its measurements and design implementation informed this work:

```text
MIT License

Copyright (c) 2018 Christopher Murphy

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.
```

This project keeps its own application name, app ID, package metadata, icons, update identity, and release configuration.

## Pomotroid camera reference

The local camera presence design was informed by [Pomotroid](https://github.com/Splode/pomotroid), including its use of a bundled BlazeFace short-range model, a confidence threshold of 0.8, and a minimum detected face height of 15% of the video. The implementation here keeps this application's Main-owned timer, manual-pause lock, input-controlled breaks, and privacy boundary. Pomotroid's MIT copyright and permission notice above also apply to this reference; no Svelte or Rust timer implementation is incorporated.

## MediaPipe Tasks Vision and BlazeFace

`@mediapipe/tasks-vision` version 0.10.32 and its JavaScript/WebAssembly runtime are distributed under Apache License 2.0, as declared by the package metadata. Source: [google-ai-edge/mediapipe](https://github.com/google-ai-edge/mediapipe). The full [Apache License 2.0 text](licenses/Apache-2.0.txt) is retained locally and copied with the camera resources at build time.

The bundled `blaze_face_short_range.tflite` is Google's BlazeFace short-range face detector, also distributed under Apache License 2.0 according to its [official model card](https://storage.googleapis.com/mediapipe-assets/MediaPipe%20BlazeFace%20Model%20Card%20%28Short%20Range%29.pdf). Model documentation and download: [Google AI Edge Face Detector](https://developers.google.com/edge/mediapipe/solutions/vision/face_detector). The file's SHA-256 is `b4578f35940bf5a1a655214a1cce5cab13eba73c1297cd78e1a04c2380b0152f`.

The model source file is `apps/desktop/resources/camera/mediapipe/blaze_face_short_range.tflite`; pre-development/pre-build preparation copies the runtime from the pinned npm package. Generated runtime files are not tracked in Git. Runtime, model, and license assets are bundled locally. They are used only to derive transient presence; no frames, face boxes, embeddings, device labels, or detection history are retained or transmitted.

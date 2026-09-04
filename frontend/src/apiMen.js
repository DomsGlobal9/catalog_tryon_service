const isDev = import.meta.env.DEV;
const API_URL = isDev
  ? "http://localhost:4005/api/v1/draping"
  : (import.meta.env.VITE_API_URL ? import.meta.env.VITE_API_URL.replace(/\/generate-catalog$/, '') : "https://api-super-admin.onrender.com/api/gateway/cat/api/v1/draping");

const API_KEY = isDev
  ? "se_catalog_internal_key_v1_99283"
  : import.meta.env.VITE_API_KEY;

export const generateCatalog = async (
  {
    fullDress,
    tops,
    category,
    categoryGroup,
    userPhoto,
    sizes,
    sizeType
  },
  onEvent,
  abortSignal = null
) => {

  const url =
    `${API_URL}/generate-catalog`;


  const payload = {

    clientId: "men-frontend",
    categoryGroup,
    category: "men",
    garmentCategory: category,

    // --------------------------------------------------------
    // SIZING
    // --------------------------------------------------------

    sizes,
    sizeType: sizeType || "standard",

    full: fullDress,
    tops: tops || null,

    // Optional user's own photo
    // null when no photo is uploaded
    userPhoto: userPhoto || null

  };


  // ----------------------------------------------------------
  // DEBUG
  // ----------------------------------------------------------

  console.log(
    "===== MEN'S GENERATION REQUEST ====="
  );

  console.log(
    "Category:",
    category
  );

  console.log(
    "Sizes:",
    sizes
  );

  console.log(
    "Garment:",
    fullDress
  );

  console.log(
    "User Photo:",
    userPhoto
      ? "Uploaded"
      : "Not uploaded"
  );

  console.log(
    "===================================="
  );


  // ----------------------------------------------------------
  // CANCEL BACKEND JOB WHEN FRONTEND ABORTS
  // ----------------------------------------------------------

  if (abortSignal) {

    abortSignal.addEventListener(
      "abort",
      () => {

        cancelGeneration(
          "men-frontend"
        );

      },
      {
        once: true
      }
    );

  }


  try {

    const response =
      await fetch(
        url,
        {

          method: "POST",

          headers: {

            "Content-Type":
              "application/json",

            "x-api-key":
              API_KEY

          },

          body:
            JSON.stringify(
              payload
            ),

          signal:
            abortSignal

        }
      );


    // --------------------------------------------------------
    // HTTP ERROR
    // --------------------------------------------------------

    if (!response.ok) {

      let errText =
        await response.text();


      try {

        const parsed =
          JSON.parse(
            errText
          );


        errText =
          parsed.error ||
          errText;

      } catch (e) {

        // Keep original error text

      }


      throw new Error(
        `Failed to generate Men's catalog: ${errText}`
      );

    }


    // --------------------------------------------------------
    // SSE STREAM
    // --------------------------------------------------------

    if (!response.body) {

      throw new Error(
        "ReadableStream is not supported in this browser."
      );

    }


    const reader =
      response.body.getReader();


    const decoder =
      new TextDecoder(
        "utf-8"
      );


    let buffer =
      "";


    while (true) {

      const {
        done,
        value
      } =
        await reader.read();


      if (done) {

        break;

      }


      buffer +=
        decoder.decode(
          value,
          {
            stream: true
          }
        );


      const chunks =
        buffer.split(
          "\n\n"
        );


      buffer =
        chunks.pop() ||
        "";


      // ------------------------------------------------------
      // PROCESS SSE EVENTS
      // ------------------------------------------------------

      for (
        const chunk
        of chunks
      ) {

        if (
          !chunk.startsWith(
            "data: "
          )
        ) {

          continue;

        }


        const jsonStr =
          chunk
            .substring(6)
            .trim();


        if (!jsonStr) {

          continue;

        }


        try {

          const eventData =
            JSON.parse(
              jsonStr
            );


          // --------------------------------------------------
          // BACKEND ERROR
          // --------------------------------------------------

          if (
            eventData.type ===
            "ERROR"
          ) {

            throw new Error(
              eventData.error
            );

          }


          // --------------------------------------------------
          // SEND EVENT TO REACT
          // --------------------------------------------------

          onEvent(
            eventData
          );


        } catch (error) {

          console.error(
            "Failed to parse SSE event:",
            jsonStr,
            error
          );


          throw error;

        }

      }

    }


    // --------------------------------------------------------
    // SUCCESS
    // --------------------------------------------------------

    return {

      success:
        true

    };


  } catch (error) {

    console.error(
      "Men's Catalog API Error:",
      error
    );


    throw error;

  }

};


// ============================================================
// CANCEL MEN'S GENERATION
// ============================================================

export const cancelGeneration = async (
  clientId = "men-frontend"
) => {

  const cancelUrl =
    `${API_URL}/cancel-job`;


  try {

    await fetch(
      cancelUrl,
      {

        method:
          "POST",

        headers: {

          "Content-Type":
            "application/json",

          "x-api-key":
            API_KEY

        },

        body:
          JSON.stringify({

            clientId

          }),

        keepalive:
          true

      }
    );


  } catch (error) {

    console.error(
      "Failed to send Men's cancellation signal:",
      error
    );

  }

};
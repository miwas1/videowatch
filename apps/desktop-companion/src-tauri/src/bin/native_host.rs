use describeops_companion::protocol::{
    decode_native_message, encode_native_message, handle_request, NativeErrorEnvelope,
    NativeRequest, NativeResponse,
};
use std::io::{self, Read, Write};

fn main() {
    if let Err(error) = run() {
        eprintln!("DescribeOps native host failed: {error}");
    }
}

fn run() -> io::Result<()> {
    let stdin = io::stdin();
    let mut input = stdin.lock();
    let stdout = io::stdout();
    let mut output = stdout.lock();

    loop {
        let mut prefix = [0_u8; 4];
        match input.read_exact(&mut prefix) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(()),
            Err(error) => return Err(error),
        }

        let len = u32::from_ne_bytes(prefix) as usize;
        let mut payload = vec![0_u8; len];
        input.read_exact(&mut payload)?;

        let mut framed = Vec::with_capacity(len + 4);
        framed.extend_from_slice(&prefix);
        framed.extend_from_slice(&payload);

        let response =
            match decode_native_message::<NativeRequest>(&framed).and_then(handle_request) {
                Ok(response) => response,
                Err(error) => NativeResponse::Err {
                    id: String::new(),
                    ok: false,
                    error: NativeErrorEnvelope {
                        code: "INVALID_NATIVE_MESSAGE".to_string(),
                        message: "DescribeOps received an invalid native message.".to_string(),
                        diagnostics: Some(error.to_string()),
                    },
                },
            };

        let encoded = encode_native_message(&response)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error.to_string()))?;
        output.write_all(&encoded)?;
        output.flush()?;
    }
}

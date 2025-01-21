import { BorshAccountsCoder, IdlAccounts } from "@coral-xyz/anchor";
import { PublicKey, Connection } from "@solana/web3.js";
import { Sandglass, IDL } from "./idl/sandglass";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import Decimal from "decimal.js";
import fs from "fs";

const RPC_URL = "https://api.mainnet-beta.solana.com";
const SANDGLASS_MARKET_ID = new PublicKey("");
const OUTPUT_FILENAME = "output.csv";

const SANDGLASS_PROGRAM_ID = new PublicKey("SANDsy8SBzwUE8Zio2mrYZYqL52Phr2WQb9DDKuXMVK");

const connection = new Connection(RPC_URL, "processed");
const coder = new BorshAccountsCoder(IDL);
type MarketState = IdlAccounts<Sandglass>["market"];
type SGState = IdlAccounts<Sandglass>["sandglassAccount"];

type ResultListState = {
  userAddress: string;
  ytTokenAmount: Decimal;
};

function setResultData(data: ResultListState[], userAddress: string, amount: Decimal, update: boolean = false) {
  const index = data.findIndex((result) => result.userAddress === userAddress);

  if (update) {
    if (index === -1) {
      return data;
    }
    data[index].ytTokenAmount = amount;
  } else {
    if (index === -1) {
      data = [
        {
          userAddress: userAddress,
          ytTokenAmount: amount,
        },
        ...data,
      ];
    } else {
      data[index].ytTokenAmount = data[index].ytTokenAmount.add(amount);
    }
  }

  return data;
}

function removeResultData(data: ResultListState[], userAddress: string) {
  const index = data.findIndex((result) => result.userAddress === userAddress);
  data.splice(index, 1);
  return data;
}

async function getSandglassAccount(
  result: ResultListState[],
  marketSigner: PublicKey,
  ytPoolAmount: Decimal,
  lpMintSupply: Decimal,
  tokenDecimals: number
) {
  const accounts = await connection.getProgramAccounts(SANDGLASS_PROGRAM_ID, {
    commitment: "processed",
    filters: [
      {
        dataSize: 416,
      },
    ],
  });

  for (const account of accounts) {
    const sandglassAccount: SGState = coder.decode("sandglassAccount", account.account.data);

    if (sandglassAccount.userAddress.toString() === marketSigner.toString()) continue;

    if (sandglassAccount.marketAccount.toString() === SANDGLASS_MARKET_ID.toString()) {
      if (Number(sandglassAccount.stakeInfo.stakeYtAmount.toString()) !== 0) {
        const userYtStakeAmount = new Decimal(sandglassAccount.stakeInfo.stakeYtAmount.toString());
        result = setResultData(result, sandglassAccount.userAddress.toString(), userYtStakeAmount.div(tokenDecimals));
      }
      if (Number(sandglassAccount.stakeInfo.stakeLpAmount.toString()) !== 0) {
        const userLpStakeAmount = new Decimal(sandglassAccount.stakeInfo.stakeLpAmount.toString());
        const withdrawYtTokenAmount = ytPoolAmount.mul(userLpStakeAmount).div(lpMintSupply).floor();

        result = setResultData(
          result,
          sandglassAccount.userAddress.toString(),
          withdrawYtTokenAmount.div(tokenDecimals)
        );
      }
    }
  }

  return result;
}

async function getYtTokenAmount(result: ResultListState[], marketSigner: PublicKey, mintAddress: PublicKey) {
  const tokenProgramAccounts = await connection.getParsedProgramAccounts(TOKEN_PROGRAM_ID, {
    commitment: "processed",
    filters: [
      {
        dataSize: 165,
      },
      {
        memcmp: {
          offset: 0,
          bytes: mintAddress.toString(),
        },
      },
    ],
  });

  for (const account of tokenProgramAccounts) {
    //@ts-ignore
    if (account.account.data.parsed.info.tokenAmount.uiAmount !== 0) {
      //@ts-ignore
      const ownerAddress = account.account.data.parsed.info.owner;
      if (ownerAddress === marketSigner.toString()) continue;
      //@ts-ignore
      const tokenAmount = new Decimal(account.account.data.parsed.info.tokenAmount.uiAmount);

      result = setResultData(result, ownerAddress, tokenAmount);
    }
  }

  return result;
}

async function getLpTokenAmount(
  result: ResultListState[],
  marketSigner: PublicKey,
  mintAddress: PublicKey,
  ytPoolAmount: Decimal,
  lpMintSupply: Decimal,
  tokenDecimals: number
) {
  const tokenProgramAccounts = await connection.getParsedProgramAccounts(TOKEN_PROGRAM_ID, {
    commitment: "processed",
    filters: [
      {
        dataSize: 165,
      },
      {
        memcmp: {
          offset: 0,
          bytes: mintAddress.toString(),
        },
      },
    ],
  });

  for (const account of tokenProgramAccounts) {
    //@ts-ignore
    if (account.account.data.parsed.info.tokenAmount.uiAmount !== 0) {
      //@ts-ignore
      const ownerAddress = account.account.data.parsed.info.owner;
      if (ownerAddress === marketSigner.toString()) continue;
      //@ts-ignore
      const tokenAmount = new Decimal(account.account.data.parsed.info.tokenAmount.uiAmount);
      const withdrawYtTokenAmount = ytPoolAmount.mul(tokenAmount.mul(tokenDecimals)).div(lpMintSupply).floor();

      result = setResultData(result, ownerAddress, withdrawYtTokenAmount.div(tokenDecimals));
    }
  }

  return result;
}

async function updateFeeAccount(
  result: ResultListState[],
  feeLpTokenAccount: PublicKey,
  ytPoolAmount: Decimal,
  lpMintSupply: Decimal,
  tokenDecimals: number
) {
  const accountInfo = await connection.getParsedAccountInfo(feeLpTokenAccount);

  //@ts-ignore
  const feeAccountOwner = accountInfo.value?.data.parsed.info.owner;

  for (const data of result) {
    if (data.userAddress === feeAccountOwner.toString()) {
      const initYtTokenAmount = ytPoolAmount.mul(new Decimal(1).mul(tokenDecimals)).div(lpMintSupply).floor();
      const newAmount = new Decimal(data.ytTokenAmount).minus(initYtTokenAmount.div(tokenDecimals));
      if (newAmount.eq(0)) {
        removeResultData(result, data.userAddress);
      } else {
        result = setResultData(result, data.userAddress, newAmount, true);
      }
      break;
    }
  }

  return result;
}

async function getMarket(address: PublicKey) {
  const accountInfo = await connection.getAccountInfo(address);
  const data = Buffer.from(accountInfo!.data);
  const coder = new BorshAccountsCoder(IDL);
  const market: MarketState = coder.decode("market", data);

  return market;
}

async function getTokenAmount(address: PublicKey) {
  const tokenAmount = await connection.getTokenAccountBalance(address);
  if (tokenAmount.value.amount) {
    return new Decimal(tokenAmount.value.amount);
  } else {
    return new Decimal(0);
  }
}

async function getMintSupply(address: PublicKey) {
  const mintAmount = await connection.getTokenSupply(address);
  if (mintAmount.value.amount) {
    return new Decimal(mintAmount.value.amount);
  } else {
    return new Decimal(0);
  }
}

function convertToCSV(result: ResultListState[]) {
  const array = typeof result !== "object" ? JSON.parse(result) : result;
  let str =
    `${Object.keys(array[0])
      .map((value) => `${value}`)
      .join(",")}` + "\r\n";

  return array.reduce((str: string, next: { [s: string]: unknown } | ArrayLike<unknown>) => {
    str +=
      `${Object.values(next)
        .map((value) => `${value}`)
        .join(",")}` + "\r\n";
    return str;
  }, str);
}

async function main() {
  const sandglassMarket = await getMarket(SANDGLASS_MARKET_ID);

  const ytPoolAmount = await getTokenAmount(sandglassMarket.poolYtTokenAccount);
  const lpMintSupply = await getMintSupply(sandglassMarket.tokenLpMintAddress);

  let resultList: ResultListState[] = [];

  resultList = await getSandglassAccount(
    resultList,
    sandglassMarket.marketSigner,
    ytPoolAmount,
    lpMintSupply,
    Number(sandglassMarket.marketConfig.priceBase.toString())
  );
  resultList = await getYtTokenAmount(resultList, sandglassMarket.marketSigner, sandglassMarket.tokenYtMintAddress);
  resultList = await getLpTokenAmount(
    resultList,
    sandglassMarket.marketSigner,
    sandglassMarket.tokenLpMintAddress,
    ytPoolAmount,
    lpMintSupply,
    Number(sandglassMarket.marketConfig.priceBase.toString())
  );

  resultList = await updateFeeAccount(
    resultList,
    sandglassMarket.feeLpTokenAccount,
    ytPoolAmount,
    lpMintSupply,
    Number(sandglassMarket.marketConfig.priceBase.toString())
  );

  const csvContent = convertToCSV(resultList);

  fs.writeFileSync(OUTPUT_FILENAME, csvContent);
}

main();

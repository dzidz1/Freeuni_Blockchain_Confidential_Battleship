import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy } = hre.deployments;

  const deployedFHECounter = await deploy("FHECounter", {
    from: deployer,
    log: true,
  });
  console.log(`FHECounter contract: `, deployedFHECounter.address);

  const deployedBattleship = await deploy("ConfidentialBattleship", {
    from: deployer,
    log: true,
  });
  console.log(`ConfidentialBattleship contract: `, deployedBattleship.address);
};

export default func;
func.id = "deploy_contracts";
func.tags = ["FHECounter", "ConfidentialBattleship"];
